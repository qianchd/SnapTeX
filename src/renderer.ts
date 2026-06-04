import MarkdownIt from 'markdown-it';
// [REMOVED] import katex (Moved to rules.ts)

import { BlockTextSnapshot, LatexDocument } from './document';
import { DiffEngine, DiffResult } from './diff';
import { PreprocessRule, PatchPayload, RenderedBlockMeta, SourceLocation } from './types';
import { DEFAULT_PREPROCESS_RULES, postProcessHtml } from './rules';
import { BlockTextProvider, LatexCounterScanner } from './scanner';
import { BibEntry } from './bib';
import { R_CITATION, R_BIBLIOGRAPHY } from './patterns';
import { IFileProvider } from './file-provider';
import { normalizeUri, stableHash } from './utils';
import { ProtectionManager } from './protection'; // [NEW]

export interface RenderOptions {
    deferFullHtml?: boolean;
}

const EMPTY_TEXT_SNAPSHOT: BlockTextSnapshot = { bodyText: "", blockSpans: [] };

interface BlockSnapshot extends RenderedBlockMeta {
    hasBibliography: boolean;
    citationKeys: string[];
}

/**
 * Renderer Service.
 * Coordinates the Document Model, Diff Engine, and Markdown Rendering.
 */
export class SmartRenderer {
    private lastBlocks: BlockSnapshot[] = [];
    private lastTextSnapshot: BlockTextSnapshot = EMPTY_TEXT_SNAPSHOT;
    private lastMetaFingerprint: string = "";
    private lastMacrosJson: string = "";
    private lastCitedKeys: string[] = [];

    // Markdown Engine
    private md: MarkdownIt | null = null;

    // [NEW] Protection Manager
    public protector = new ProtectionManager();

    // [REMOVED] All specific protected arrays (protectedRenderedBlocks, etc.)

    // Configuration
    private _preprocessRules: PreprocessRule[] = [];

    // [CHANGED] Made public so rules can access it for KaTeX rendering
    public currentMacros: Record<string, string> = {};

    private blockMap: { start: number; count: number }[] = [];
    private scanner = new LatexCounterScanner();
    public globalLabelMap: Record<string, string> = {};
    public citedKeys: string[] = [];
    public currentDocument: LatexDocument | undefined;

    constructor(private fileProvider: IFileProvider) {
        this.rebuildMarkdownEngine({});
        this.reloadAllRules();
    }

    public get bibEntries(): Map<string, BibEntry> {
        return this.currentDocument ? this.currentDocument.bibEntries : new Map();
    }

    public get currentTitle(): string | undefined { return this.currentDocument?.metadata.title; }
    public get currentAuthor(): string | undefined { return this.currentDocument?.metadata.author; }
    public get currentDate(): string | undefined { return this.currentDocument?.metadata.date; }

    // --- Initialization & Config ---

    public rebuildMarkdownEngine(macros: Record<string, string>) {
        this.currentMacros = {
            "\\mathparagraph": "\\P",
            "\\mathsection": "\\S",
            ...macros
        };
        this.md = new MarkdownIt({ html: true, linkify: true });
        this.md.disable('code');
    }

    public reloadAllRules() {
        this._preprocessRules = [...DEFAULT_PREPROCESS_RULES];
        this._sortRules();
    }

    public registerPreprocessRule(rule: PreprocessRule) {
        const index = this._preprocessRules.findIndex(r => r.name === rule.name);
        if (index !== -1) {
            this._preprocessRules[index] = rule;
        } else {
            this._preprocessRules.push(rule);
        }
        this._sortRules();
    }

    private _sortRules() {
        this._preprocessRules.sort((a, b) => a.priority - b.priority);
    }

    public resetState() {
        this.lastBlocks = [];
        this.lastTextSnapshot = EMPTY_TEXT_SNAPSHOT;
        this.lastMetaFingerprint = "";
        this.lastMacrosJson = "";
        this.lastCitedKeys = [];
        this.blockMap = [];
        this.citedKeys = [];
        this.currentDocument = undefined;
    }

    // --- Helper Methods for Rules ---

    public renderInline(text: string): string {
        return this.md ? this.md.renderInline(text) : text;
    }

    public resolveCitation(key: string): number {
        let index = this.citedKeys.indexOf(key);
        if (index === -1) {
            this.citedKeys.push(key);
            index = this.citedKeys.length - 1;
        }
        return index + 1;
    }

    /**
     * [NEW] Generic protection method used by Rules.
     * @param namespace e.g. 'math', 'raw', 'ref'
     * @param content The HTML content to protect
     */
    public protect(namespace: string, content: string): string {
        return this.protector.protect(namespace, content);
    }

    public isKnownFile(uriStr: string): boolean {
        if (!this.currentDocument) { return false; }
        const target = normalizeUri(uriStr);
        if (this.currentDocument.rootDir && normalizeUri(this.currentDocument.rootDir) === target) {
             return true;
        }
        return this.currentDocument.filePool.some(file => normalizeUri(file) === target);
    }

    // --- Core Rendering Logic ---

    private renderBlockToHtml(text: string, index: number): string {
        let processed = text;

        // 1. Apply Rules (Rules now call renderer.protect() directly)
        this._preprocessRules.forEach(rule => { processed = rule.apply(processed, this); });

        // 2. Render Markdown (Tokens like XSNAP:math:0Y are treated as plain text)
        let finalHtml = this.md!.render(processed);

        // 3. Universal Recursive Resolution
        // Replaces all tokens, including nested ones (e.g. Ref inside Math)
        finalHtml = this.protector.resolve(finalHtml);

        if (finalHtml.includes('OOABSTRACT') || finalHtml.includes('OOKEYWORDS')) {
            finalHtml = postProcessHtml(finalHtml);
        }

        this.protector.reset();

        return `<div class="latex-block" data-index="${index}" data-block-hash="${stableHash(text)}">${finalHtml}</div>`;
    }

    private extractLocalBlockAnchors(text: string): string[] {
        const anchors = new Set<string>();
        const labelRegex = /\\label\s*\{([^}]+)\}/g;
        let match;
        while ((match = labelRegex.exec(text)) !== null) {
            anchors.add(match[1]);
        }

        return Array.from(anchors);
    }

    private applyMetadataFingerprint(text: string, metaFingerprint: string): string {
        return text.includes('\\maketitle') ? text.replace('\\maketitle', `\\maketitle${metaFingerprint}`) : text;
    }

    private getSnapshotBlockText(snapshot: BlockTextSnapshot, index: number, metaFingerprint: string): string | undefined {
        const span = snapshot.blockSpans[index];
        if (!span) { return undefined; }
        return this.applyMetadataFingerprint(snapshot.bodyText.slice(span.start, span.end), metaFingerprint);
    }

    private extractCitationKeys(text: string): string[] {
        const keys = new Set<string>();
        R_CITATION.lastIndex = 0;
        let match;
        while ((match = R_CITATION.exec(text)) !== null) {
            const keyParts = match[4].split(',');
            keyParts.forEach(key => keys.add(key.trim()));
        }
        return Array.from(keys);
    }

    private buildBlockMeta(text: string, index: number): BlockSnapshot {
        const map = this.blockMap[index];
        return {
            index,
            hash: stableHash(text),
            line: map?.start ?? 0,
            lineCount: map?.count ?? text.split(/\r?\n/).length,
            anchors: this.extractLocalBlockAnchors(text),
            hasBibliography: R_BIBLIOGRAPHY.test(text),
            citationKeys: this.extractCitationKeys(text)
        };
    }

    private repositionBlockSnapshot(block: BlockSnapshot, index: number): BlockSnapshot {
        const map = this.blockMap[index];
        return {
            ...block,
            index,
            line: map?.start ?? 0,
            lineCount: map?.count ?? block.lineCount
        };
    }

    private buildNextBlockSnapshots(blockCount: number, diff: DiffResult, getBlockText: (index: number) => string): BlockSnapshot[] {
        const next: BlockSnapshot[] = new Array(blockCount);
        const changedEnd = diff.start + diff.insertCount;
        const suffixOffset = diff.deleteCount - diff.insertCount;

        for (let index = 0; index < diff.start; index++) {
            const oldBlock = this.lastBlocks[index];
            next[index] = oldBlock ? this.repositionBlockSnapshot(oldBlock, index) : this.buildBlockMeta(getBlockText(index), index);
        }

        for (let index = diff.start; index < changedEnd; index++) {
            next[index] = this.buildBlockMeta(getBlockText(index), index);
        }

        for (let index = changedEnd; index < blockCount; index++) {
            const oldBlock = this.lastBlocks[index + suffixOffset];
            next[index] = oldBlock ? this.repositionBlockSnapshot(oldBlock, index) : this.buildBlockMeta(getBlockText(index), index);
        }

        return next;
    }

    private collectCitedKeys(blocks: BlockSnapshot[]): string[] {
        const keys: string[] = [];
        for (const block of blocks) {
            for (const key of block.citationKeys) {
                if (!keys.includes(key)) {
                    keys.push(key);
                }
            }
        }
        return keys;
    }

    private applyBibliographyAnchors(blocks: BlockSnapshot[], citedKeys: string[]): BlockSnapshot[] {
        return blocks.map(block => {
            if (!block.hasBibliography) { return block; }
            const anchors = new Set(block.anchors);
            citedKeys.forEach(key => anchors.add(`ref-${key}`));
            return {
                ...block,
                anchors: Array.from(anchors)
            };
        });
    }

    private haveSameCitedKeys(nextKeys: string[]): boolean {
        if (nextKeys.length !== this.lastCitedKeys.length) { return false; }
        for (let i = 0; i < nextKeys.length; i++) {
            if (nextKeys[i] !== this.lastCitedKeys[i]) { return false; }
        }
        return true;
    }

    public renderBlockByIndex(index: number): string | undefined {
        const text = this.getSnapshotBlockText(this.lastTextSnapshot, index, this.lastMetaFingerprint);
        if (text === undefined) { return undefined; }
        return this.renderBlockToHtml(text, index);
    }

    public getBlockMeta(index: number): RenderedBlockMeta | undefined {
        return this.lastBlocks[index];
    }

    public render(doc: LatexDocument, options: RenderOptions = {}): PatchPayload {
        this.currentDocument = doc;

        // Reset protector state
        this.protector.reset();

        // 1. Macros
        const currentMacrosJson = JSON.stringify(doc.metadata.macros);
        const macrosChanged = currentMacrosJson !== this.lastMacrosJson;
        if (macrosChanged) {
            this.rebuildMarkdownEngine(doc.metadata.macros);
            this.lastBlocks = [];
            this.lastTextSnapshot = EMPTY_TEXT_SNAPSHOT;
            this.lastMetaFingerprint = "";
            this.lastMacrosJson = currentMacrosJson;
        }

        // 2. Prepare text blocks
        const safeTitle = (this.currentTitle || '').replace(/[\r\n]/g, ' ');
        const safeAuthor = (this.currentAuthor || '').replace(/[\r\n]/g, ' ');
        const safeDate = (this.currentDate || '').replace(/[\r\n]/g, ' ');
        const metaFingerprint = ` [meta:${stableHash(`${safeTitle}\u0000${safeAuthor}\u0000${safeDate}`)}]`;

        const blockCount = doc.getBlockCount();
        const newTextCache = new Map<number, string>();
        const newHashCache = new Map<number, string>();
        const getNewBlockText = (index: number): string => {
            if (!newTextCache.has(index)) {
                const rawText = doc.getBlockText(index) ?? '';
                newTextCache.set(index, this.applyMetadataFingerprint(rawText, metaFingerprint));
            }
            return newTextCache.get(index) ?? '';
        };
        const getNewBlockHash = (index: number): string => {
            const rawHash = doc.getBlockHash(index);
            if (!doc.isMetadataSensitiveBlock(index)) {
                return rawHash ?? stableHash(getNewBlockText(index));
            }
            if (!newHashCache.has(index)) {
                newHashCache.set(index, stableHash(getNewBlockText(index)));
            }
            return newHashCache.get(index) ?? '';
        };
        const newBlockProvider: BlockTextProvider = {
            getBlockCount: () => blockCount,
            getBlockText: getNewBlockText,
            getBlockHash: getNewBlockHash
        };
        const newHashBlocks = Array.from({ length: blockCount }, (_unused, index) => ({ hash: getNewBlockHash(index) }));

        // 3. Block Map
        this.blockMap = doc.blockSpans.map(span => ({
            start: doc.contentStartLineOffset + span.line,
            count: span.lineCount
        }));

        // 4. Scanner
        const scanResult = this.scanner.scan(newBlockProvider);
        this.globalLabelMap = scanResult.labelMap;

        const numberingMap: { [index: number]: any } = {};
        scanResult.blockNumbering.forEach((bn, idx) => {
            if (Object.values(bn.counts).some(arr => arr.length > 0)) {
                numberingMap[idx] = bn.counts;
            }
        });
        const numberingData = { blocks: numberingMap, labels: scanResult.labelMap };

        // 5. Diff
        const diff = DiffEngine.compute(this.lastBlocks, newHashBlocks);

        // 6. Determine Update Strategy (Evaluate using diff.insertCount instead of insertedHtmls.length)
        const isFullUpdate = this.lastBlocks.length === 0 || diff.insertCount > 50 || diff.deleteCount > 50;
        let payload: PatchPayload;
        let blockMeta = this.buildNextBlockSnapshots(blockCount, diff, getNewBlockText);
        const nextCitedKeys = this.collectCitedKeys(blockMeta);
        const keysChanged = !this.haveSameCitedKeys(nextCitedKeys);
        this.citedKeys = nextCitedKeys;
        this.lastCitedKeys = [...nextCitedKeys];
        blockMeta = this.applyBibliographyAnchors(blockMeta, nextCitedKeys);
        const nextTextSnapshot = doc.createTextSnapshot();

        if (isFullUpdate) {
            // [Full Render] Branch
            this.lastBlocks = blockMeta;
            this.lastTextSnapshot = nextTextSnapshot;
            this.lastMetaFingerprint = metaFingerprint;

            payload = {
                type: 'full',
                htmls: options.deferFullHtml
                    ? undefined
                    : Array.from({ length: blockCount }, (_unused, index) => this.renderBlockToHtml(getNewBlockText(index), index)),
                blocks: options.deferFullHtml ? blockMeta : undefined,
                start: undefined,
                deleteCount: undefined,
                shift: undefined,
                preserveUnchangedBlocks: !macrosChanged,
                numbering: numberingData,
                dirtyBlocks: undefined
            };
        } else {
            // [Partial/Patch Render] Branch
            // Only consume CPU to render changed blocks if we are sure a full update is not needed
            const insertedHtmls: string[] = [];
            for (let i = 0; i < diff.insertCount; i++) {
                const absoluteIndex = diff.start + i;
                insertedHtmls.push(this.renderBlockToHtml(getNewBlockText(absoluteIndex), absoluteIndex));
            }

            let shift = 0;
            if (diff.end > 0 && insertedHtmls.length !== diff.deleteCount) {
                shift = insertedHtmls.length - diff.deleteCount;
            }

            this.lastBlocks = blockMeta;
            this.lastTextSnapshot = nextTextSnapshot;
            this.lastMetaFingerprint = metaFingerprint;

            const dirtyBlocksMap: { [index: number]: string } = {};
            if (keysChanged) {
                const bibBlockIndex = this.lastBlocks.findIndex(block => block.hasBibliography);
                const isInsideMainPatch = bibBlockIndex >= diff.start && bibBlockIndex < (diff.start + diff.insertCount);
                if (bibBlockIndex !== -1 && !isInsideMainPatch) {
                    const text = this.getSnapshotBlockText(this.lastTextSnapshot, bibBlockIndex, this.lastMetaFingerprint);
                    if (text !== undefined) {
                        dirtyBlocksMap[bibBlockIndex] = this.renderBlockToHtml(text, bibBlockIndex);
                    }
                }
            }

            payload = {
                type: 'patch',
                start: diff.start,
                deleteCount: diff.deleteCount,
                htmls: insertedHtmls,
                shift: shift,
                numbering: numberingData,
                dirtyBlocks: dirtyBlocksMap
            };
        }

        // [Deep GC] Clear protection storage
        this.protector.reset();

        return payload;
    }

    // --- Helpers ---

    public getPreviewSyncData(filePath: string, line: number) {
        if (!this.currentDocument) {return null;}
        const flatLine = this.currentDocument.getFlattenedLine(filePath, line);
        return flatLine !== -1 ? this.getBlockIndexByLine(flatLine) : null;
    }

    public getSourceSyncData(blockIndex: number, ratio: number): SourceLocation | null {
        if (!this.currentDocument) {return null;}
        const flatLine = this.getLineByBlockIndex(blockIndex, ratio);
        return this.currentDocument.getOriginalPosition(flatLine) || null;
    }

    public getBlockIndexByLine(line: number): { index: number; ratio: number } {
        if (this.blockMap.length === 0) { return { index: 0, ratio: 0 }; }
        if (line < this.blockMap[0].start) { return { index: 0, ratio: 0 }; }
        for (let i = 0; i < this.blockMap.length; i++) {
            const b = this.blockMap[i];
            const nextStart = (i + 1 < this.blockMap.length) ? this.blockMap[i+1].start : Infinity;
            if (line >= b.start && line < nextStart) {
                const ratio = Math.max(0, Math.min(1, (line - b.start) / Math.max(1, b.count)));
                return { index: i, ratio };
            }
        }
        return { index: this.blockMap.length - 1, ratio: 0 };
    }

    public getLineByBlockIndex(index: number, ratio: number): number {
        if (index >= 0 && index < this.blockMap.length) {
            const b = this.blockMap[index];
            return b.start + Math.floor(b.count * ratio);
        }
        return 0;
    }

    public getOriginalPosition(flatLine: number): SourceLocation | undefined {
        return this.currentDocument?.getOriginalPosition(flatLine);
    }

    public getFlattenedLine(fsPath: string, originalLine: number): number {
        return this.currentDocument ? this.currentDocument.getFlattenedLine(fsPath, originalLine) : -1;
    }
}
