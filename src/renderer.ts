import MarkdownIt from 'markdown-it';
// [REMOVED] import katex (Moved to rules.ts)

import { BlockTextSnapshot, LatexDocument } from './document';
import { DiffEngine } from './diff';
import { PreprocessRule, PatchPayload, RenderedBlockMeta, SourceLocation } from './types';
import { DEFAULT_PREPROCESS_RULES, postProcessHtml } from './rules';
import { LatexCounterScanner } from './scanner';
import { BibEntry } from './bib';
import { R_CITATION, R_BIBLIOGRAPHY } from './patterns';
import { IFileProvider } from './file-provider';
import { normalizeUri, stableHash } from './utils';
import { ProtectionManager } from './protection'; // [NEW]

export interface RenderOptions {
    deferFullHtml?: boolean;
}

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
    private lastTextSnapshot: BlockTextSnapshot = { bodyText: "", blockSpans: [], blockHashes: [] };
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
        this.lastTextSnapshot = { bodyText: "", blockSpans: [], blockHashes: [] };
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

    private extractBlockAnchors(text: string): string[] {
        const anchors = new Set<string>();
        const labelRegex = /\\label\s*\{([^}]+)\}/g;
        let match;
        while ((match = labelRegex.exec(text)) !== null) {
            anchors.add(match[1]);
        }

        if (R_BIBLIOGRAPHY.test(text)) {
            this.citedKeys.forEach(key => anchors.add(`ref-${key}`));
        }

        return Array.from(anchors);
    }

    private applyMetadataFingerprint(text: string, metaFingerprint: string): string {
        const trimmed = text.trim();
        return trimmed.includes('\\maketitle') ? trimmed.replace('\\maketitle', `\\maketitle${metaFingerprint}`) : trimmed;
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
            anchors: this.extractBlockAnchors(text),
            hasBibliography: R_BIBLIOGRAPHY.test(text),
            citationKeys: this.extractCitationKeys(text)
        };
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
            this.lastTextSnapshot = { bodyText: "", blockSpans: [], blockHashes: [] };
            this.lastMetaFingerprint = "";
            this.lastMacrosJson = currentMacrosJson;
        }

        // 2. Prepare text blocks
        const safeTitle = (this.currentTitle || '').replace(/[\r\n]/g, ' ');
        const safeAuthor = (this.currentAuthor || '').replace(/[\r\n]/g, ' ');
        const safeDate = (this.currentDate || '').replace(/[\r\n]/g, ' ');
        const metaFingerprint = ` [meta:${stableHash(`${safeTitle}\u0000${safeAuthor}\u0000${safeDate}`)}]`;

        const newBlockTexts = Array.from({ length: doc.getBlockCount() }, (_unused, index) => {
            const rawText = doc.getBlockText(index) ?? '';
            return this.applyMetadataFingerprint(rawText, metaFingerprint);
        });
        const newHashBlocks = newBlockTexts.map(text => ({ hash: stableHash(text) }));

        // 3. Block Map
        this.blockMap = doc.blockLines.map((line, i) => ({
            start: doc.contentStartLineOffset + line,
            count: doc.blockLineCounts[i]
        }));

        // 4. Scanner
        const scanResult = this.scanner.scan(newBlockTexts);
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

        // 6. Citations
        const bibRegex = R_BIBLIOGRAPHY;
        let bibChanged = false;

        for (let i = 0; i < diff.insertCount; i++) {
            if (bibRegex.test(newBlockTexts[diff.start + i])) { bibChanged = true; break; }
        }
        if (!bibChanged) {
            for (let i = 0; i < diff.deleteCount; i++) {
                if (this.lastBlocks[diff.start + i]?.hasBibliography) { bibChanged = true; break; }
            }
        }

        let shouldFullScan = false;
        if (bibChanged || this.lastBlocks.length === 0) {
            shouldFullScan = true;
        } else {
            const deletedKeys = this.extractKeysFromSnapshots(this.lastBlocks, diff.start, diff.deleteCount);
            const insertedKeys = this.extractKeysFromBlocks(newBlockTexts, diff.start, diff.insertCount);

            if (deletedKeys.size !== insertedKeys.size) {
                shouldFullScan = true;
            } else {
                for (const key of deletedKeys) {
                    if (!insertedKeys.has(key)) {
                        shouldFullScan = true;
                        break;
                    }
                }
            }
        }

        if (shouldFullScan) {
            this.citedKeys = [];
            this.scanCitations(newBlockTexts);
        } else {
            this.citedKeys = [...this.lastCitedKeys];
        }

        let keysChanged = this.citedKeys.length !== this.lastCitedKeys.length;
        if (!keysChanged) {
            for (let i = 0; i < this.citedKeys.length; i++) {
                if (this.citedKeys[i] !== this.lastCitedKeys[i]) {
                    keysChanged = true;
                    break;
                }
            }
        }
        this.lastCitedKeys = [...this.citedKeys];

        // 7. Determine Update Strategy (Evaluate using diff.insertCount instead of insertedHtmls.length)
        const isFullUpdate = this.lastBlocks.length === 0 || diff.insertCount > 50 || diff.deleteCount > 50;
        let payload: PatchPayload;
        const blockMeta = newBlockTexts.map((text, index) => this.buildBlockMeta(text, index));
        const nextTextSnapshot = doc.createTextSnapshot();

        if (isFullUpdate) {
            // [Full Render] Branch
            this.lastBlocks = blockMeta;
            this.lastTextSnapshot = nextTextSnapshot;
            this.lastMetaFingerprint = metaFingerprint;

            payload = {
                type: 'full',
                htmls: options.deferFullHtml ? undefined : newBlockTexts.map((text, index) => this.renderBlockToHtml(text, index)),
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
                insertedHtmls.push(this.renderBlockToHtml(newBlockTexts[absoluteIndex], absoluteIndex));
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

    private scanCitations(blocks: string[]) {
        blocks.forEach(text => {
            R_CITATION.lastIndex = 0;
            let match;
            while ((match = R_CITATION.exec(text)) !== null) {
                const keys = match[4].split(',').map(k => k.trim());
                keys.forEach(key => this.resolveCitation(key));
            }
        });
    }

    private extractKeysFromBlocks(blocks: string[], start: number, count: number): Set<string> {
        const keys = new Set<string>();
        for (let i = 0; i < count; i++) {
            this.extractCitationKeys(blocks[start + i]).forEach(key => keys.add(key));
        }
        return keys;
    }

    private extractKeysFromSnapshots(blocks: BlockSnapshot[], start: number, count: number): Set<string> {
        const keys = new Set<string>();
        for (let i = 0; i < count; i++) {
            blocks[start + i]?.citationKeys.forEach(key => keys.add(key));
        }
        return keys;
    }

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
