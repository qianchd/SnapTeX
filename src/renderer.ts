import MarkdownIt from 'markdown-it';
// [REMOVED] import katex (Moved to rules.ts)

import { LatexDocument } from './document';
import { DiffEngine } from './diff';
import { PreprocessRule, PatchPayload, SourceLocation } from './types';
import { DEFAULT_PREPROCESS_RULES, postProcessHtml } from './rules';
import { LatexCounterScanner } from './scanner';
import { BibEntry } from './bib';
import { R_CITATION, R_BIBLIOGRAPHY } from './patterns';
import { IFileProvider } from './file-provider';
import { normalizeUri } from './utils';
import { ProtectionManager } from './protection'; // [NEW]

/**
 * Renderer Service.
 * Coordinates the Document Model, Diff Engine, and Markdown Rendering.
 */
export class SmartRenderer {
    private lastBlockTexts: string[] = [];
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
    }

    private _sortRules() {
        this._preprocessRules.sort((a, b) => a.priority - b.priority);
    }

    public resetState() {
        this.lastBlockTexts = [];
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

    // [REMOVED] pushInlineProtected, pushProtectedRef, renderAndProtectMath
    // These specific logics are moved to rules.ts

    public isKnownFile(uriStr: string): boolean {
        if (!this.currentDocument) { return false; }
        const target = normalizeUri(uriStr);
        if (this.currentDocument.rootDir && normalizeUri(this.currentDocument.rootDir) === target) {
             return true;
        }
        return this.currentDocument.sourceMap.some(loc => normalizeUri(loc.file) === target);
    }

    // --- Core Rendering Logic ---

    private renderBlockToHtml(text: string, index: number): string {
        let processed = text;

        // 1. Apply Rules (Rules now call renderer.protect() directly)
        this._preprocessRules.forEach(rule => { processed = rule.apply(processed, this); });

        // 2. Render Markdown (Tokens like XSNAP:math:0Y are treated as plain text)
        let finalHtml = this.md!.render(processed);

        // 3. [UPDATED] Universal Recursive Resolution
        // Replaces all tokens, including nested ones (e.g. Ref inside Math)
        finalHtml = this.protector.resolve(finalHtml);

        // [REMOVED] Specific restore calls (restoreRenderedMath, restoreRawBlocks)

        if (finalHtml.includes('OOABSTRACT') || finalHtml.includes('OOKEYWORDS')) {
            finalHtml = postProcessHtml(finalHtml);
        }

        return `<div class="latex-block" data-index="${index}">${finalHtml}</div>`;
    }

    public render(doc: LatexDocument): PatchPayload {
        this.currentDocument = doc;

        // [UPDATED] Reset protector state
        this.protector.reset();

        // 1. Macros
        const currentMacrosJson = JSON.stringify(doc.metadata.macros);
        if (currentMacrosJson !== this.lastMacrosJson) {
            this.rebuildMarkdownEngine(doc.metadata.macros);
            this.lastBlockTexts = [];
            this.lastMacrosJson = currentMacrosJson;
        }

        // 2. Prepare text blocks
        const safeTitle = (this.currentTitle || '').replace(/[\r\n]/g, ' ');
        const safeAuthor = (this.currentAuthor || '').replace(/[\r\n]/g, ' ');
        const safeDate = (this.currentDate || '').replace(/[\r\n]/g, ' ');
        const metaFingerprint = ` [meta:${safeTitle}|${safeAuthor}|${safeDate}]`;

        const newBlockTexts = doc.blockTexts.map(rawText => {
            const trimmed = rawText.trim();
            return trimmed.includes('\\maketitle') ? (trimmed + metaFingerprint) : trimmed;
        });

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
        const diff = DiffEngine.compute(this.lastBlockTexts, newBlockTexts);

        // 6. Citations
        const insertedFullText = diff.insertedTexts.join('\n');
        const deletedFullText = diff.deletedTexts.join('\n');
        const bibRegex = R_BIBLIOGRAPHY;
        const bibChanged = bibRegex.test(insertedFullText) || bibRegex.test(deletedFullText);

        let shouldFullScan = false;
        if (bibChanged || this.lastBlockTexts.length === 0) {
            shouldFullScan = true;
        } else {
            const deletedKeys = this.extractKeysFromText(deletedFullText);
            const insertedKeys = this.extractKeysFromText(insertedFullText);
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

        const keysChanged = JSON.stringify(this.citedKeys) !== JSON.stringify(this.lastCitedKeys);
        this.lastCitedKeys = [...this.citedKeys];

        // 7. Render Inserted Blocks
        const insertedHtmls = diff.insertedTexts.map((text, i) => {
            const absoluteIndex = diff.start + i;
            return this.renderBlockToHtml(text, absoluteIndex);
        });

        // 8. Payload
        const isFullUpdate = this.lastBlockTexts.length === 0 || insertedHtmls.length > 50 || diff.deleteCount > 50;
        let payload: PatchPayload;

        if (isFullUpdate) {
            const fullHtml = newBlockTexts.map((text, index) => this.renderBlockToHtml(text, index)).join('');
            this.lastBlockTexts = newBlockTexts;
            payload = { type: 'full', html: fullHtml, numbering: numberingData };
        } else {
            let shift = 0;
            if (diff.end > 0 && insertedHtmls.length !== diff.deleteCount) {
                shift = insertedHtmls.length - diff.deleteCount;
            }
            this.lastBlockTexts = [
                ...this.lastBlockTexts.slice(0, diff.start),
                ...diff.insertedTexts,
                ...this.lastBlockTexts.slice(this.lastBlockTexts.length - diff.end)
            ];

            const dirtyBlocksMap: { [index: number]: string } = {};
            if (keysChanged) {
                const bibBlockIndex = this.lastBlockTexts.findIndex(text => /\\bibliography\{/.test(text));
                const isInsideMainPatch = bibBlockIndex >= diff.start && bibBlockIndex < (diff.start + insertedHtmls.length);
                if (bibBlockIndex !== -1 && !isInsideMainPatch) {
                    dirtyBlocksMap[bibBlockIndex] = this.renderBlockToHtml(this.lastBlockTexts[bibBlockIndex], bibBlockIndex);
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

    private extractKeysFromText(text: string): Set<string> {
        const keys = new Set<string>();
        R_CITATION.lastIndex = 0;
        let match;
        while ((match = R_CITATION.exec(text)) !== null) {
            const keyParts = match[4].split(',');
            keyParts.forEach(k => keys.add(k.trim()));
        }
        return keys;
    }

    // [REMOVED] restoreRenderedMath, restoreRawBlocks

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