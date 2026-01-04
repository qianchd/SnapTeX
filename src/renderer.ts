import MarkdownIt from 'markdown-it';
const katex = require('katex');
import * as path from 'path';
import * as os from 'os';

import { LatexDocument } from './document';
import { DiffEngine } from './diff';
import { PreprocessRule, PatchPayload, SourceLocation } from './types';
import { DEFAULT_PREPROCESS_RULES, postProcessHtml } from './rules';
import { LatexCounterScanner, ScanResult } from './scanner';
import { BibEntry } from './bib';
import { R_CITATION, R_BIBLIOGRAPHY } from './patterns';
import { IFileProvider } from './file-provider';

/**
 * Renderer Service.
 * Coordinates the Document Model, Diff Engine, and Markdown Rendering.
 * Acts as the single source of truth for document synchronization logic.
 */
export class SmartRenderer {
    // [Memory Optimization]
    // Removed `lastBlocks: { text: string, html: string }[]` which duplicated the entire DOM in memory.
    // We only store the plain text of blocks for Diffing.
    private lastBlockTexts: string[] = [];

    private lastMacrosJson: string = "";
    private lastCitedKeys: string[] = [];

    // Markdown Engine
    private md: MarkdownIt | null = null;

    // Protection Buffers
    private protectedRenderedBlocks: string[] = [];
    private protectedRawBlocks: string[] = [];
    private protectedRefs: string[] = [];

    // Configuration
    private _preprocessRules: PreprocessRule[] = [];
    private currentMacros: Record<string, string> = {};

    // Mapping for Sync Scroll (Block Index -> Line Number)
    private blockMap: { start: number; count: number }[] = [];

    // Scanners
    private scanner = new LatexCounterScanner();
    public globalLabelMap: Record<string, string> = {};
    public citedKeys: string[] = [];

    // Current Context
    public currentDocument: LatexDocument | undefined;

    constructor(private fileProvider: IFileProvider) {
        this.rebuildMarkdownEngine({});
        this.reloadAllRules();
    }

    /**
     * Accessor used by rules.ts to look up BibEntries
     */
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

    public reloadAllRules(workspaceRoot?: string) {
        this._preprocessRules = [...DEFAULT_PREPROCESS_RULES];
        const globalConfigPath = path.join(os.homedir(), '.snaptex.global.js');
        this.loadConfig(globalConfigPath);
        if (workspaceRoot) {
            const workspaceConfigPath = path.join(workspaceRoot, 'snaptex.config.js');
            this.loadConfig(workspaceConfigPath);
        }
        this._sortRules();
    }

    private loadConfig(configPath: string) {
        if (this.fileProvider.exists(configPath)) {
            try {
                delete require.cache[require.resolve(configPath)];
                const userConfig = require(configPath);
                if (userConfig && Array.isArray(userConfig.rules)) {
                    userConfig.rules.forEach((r: PreprocessRule) => this.registerPreprocessRule(r));
                }
            } catch (e) {
                console.error(`[TeX Preview] Failed to load config file: ${configPath}`, e);
            }
        }
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
        // [Memory Optimization] Clear text cache
        this.lastBlockTexts = [];
        this.lastMacrosJson = "";
        this.lastCitedKeys = [];
        this.blockMap = [];
        this.citedKeys = [];
        this.currentDocument = undefined;
    }

    // --- Helper Methods for Rules ---

    public renderInline(text: string): string {
        if (!this.md) { return text; }
        return this.md.renderInline(text);
    }

    public resolveCitation(key: string): number {
        let index = this.citedKeys.indexOf(key);
        if (index === -1) {
            this.citedKeys.push(key);
            index = this.citedKeys.length - 1;
        }
        return index + 1;
    }

    public pushInlineProtected(content: string) {
        const index = this.protectedRawBlocks.length;
        this.protectedRawBlocks.push(content);
        return `OOSNAPTEXRAW${index}OO`;
    }

    public pushProtectedRef(key: string) {
        const index = this.protectedRefs.length;
        this.protectedRefs.push(key);
        return `SNREF${index}END`;
    }

    public renderAndProtectMath(tex: string, displayMode: boolean): string {
        try {
            const html = katex.renderToString(tex, {
                displayMode: displayMode,
                macros: this.currentMacros,
                throwOnError: false,
                errorColor: '#cc0000',
                globalGroup: true
            });
            const index = this.protectedRenderedBlocks.length;
            this.protectedRenderedBlocks.push(html);
            return `OOSNAPTEXMATH${index}OO`;
        } catch (e) {
            return `<span style="color:red">Math Error: ${(e as Error).message}</span>`;
        }
    }

    // --- Core Rendering Logic ---

    /**
     * Helper to render a single block text to HTML
     */
    private renderBlockToHtml(text: string, index: number): string {
        let processed = text;
        this._preprocessRules.forEach(rule => { processed = rule.apply(processed, this); });

        let finalHtml = this.md!.render(processed);
        finalHtml = this.restoreRenderedMath(finalHtml);
        finalHtml = this.restoreRawBlocks(finalHtml);

        if (finalHtml.includes('OOABSTRACT') || finalHtml.includes('OOKEYWORDS')) {
            finalHtml = postProcessHtml(finalHtml);
        }

        return `<div class="latex-block" data-index="${index}">${finalHtml}</div>`;
    }

    public render(doc: LatexDocument): PatchPayload {
        this.currentDocument = doc;
        this.protectedRenderedBlocks = [];
        this.protectedRawBlocks = [];

        // 1. Check for macro updates
        const currentMacrosJson = JSON.stringify(doc.metadata.macros);
        if (currentMacrosJson !== this.lastMacrosJson) {
            this.rebuildMarkdownEngine(doc.metadata.macros);
            this.lastBlockTexts = []; // Force full re-render
            this.lastMacrosJson = currentMacrosJson;
        }

        // 2. Prepare text blocks for Diffing
        const safeTitle = (this.currentTitle || '').replace(/[\r\n]/g, ' ');
        const safeAuthor = (this.currentAuthor || '').replace(/[\r\n]/g, ' ');
        const safeDate = (this.currentDate || '').replace(/[\r\n]/g, ' ');
        const metaFingerprint = ` [meta:${safeTitle}|${safeAuthor}|${safeDate}]`;

        const newBlockTexts = doc.blocks.map(b => {
            const rawText = b.text.trim();
            return rawText.includes('\\maketitle') ? (rawText + metaFingerprint) : rawText;
        });

        // 3. Build Block Map
        this.blockMap = doc.blocks.map(b => ({
            start: doc.contentStartLineOffset + b.line,
            count: b.lineCount
        }));

        // 4. Run Scanner
        const scanResult = this.scanner.scan(newBlockTexts);
        this.globalLabelMap = scanResult.labelMap;

        const numberingMap: { [index: number]: any } = {};
        scanResult.blockNumbering.forEach((bn, idx) => {
            if (Object.values(bn.counts).some(arr => arr.length > 0)) {
                numberingMap[idx] = bn.counts;
            }
        });
        const numberingData = {
            blocks: numberingMap,
            labels: scanResult.labelMap
        };

        // 5. Diff Computation (Compare Texts Only)
        // [Memory Optimization] Diffing now operates on string[], no need to map from object array
        const diff = DiffEngine.compute(this.lastBlockTexts, newBlockTexts);

        // 6. Citation Analysis
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

        // 7. Render Inserted Blocks (Just the new ones)
        const insertedHtmls = diff.insertedTexts.map((text, i) => {
            const absoluteIndex = diff.start + i;
            return this.renderBlockToHtml(text, absoluteIndex);
        });

        // 8. Decide Payload Type (Full vs Patch)
        // If too many changes, or first load, do Full Update.
        const isFullUpdate = this.lastBlockTexts.length === 0 || insertedHtmls.length > 50 || diff.deleteCount > 50;

        let payload: PatchPayload;

        if (isFullUpdate) {
            // [Memory Optimization]
            // On full update, we re-render EVERYTHING.
            // We do NOT rely on cached HTML (which is gone).
            const fullHtml = newBlockTexts.map((text, index) => {
                return this.renderBlockToHtml(text, index);
            }).join('');

            // Update Cache (State Transition)
            this.lastBlockTexts = newBlockTexts;

            payload = {
                type: 'full',
                html: fullHtml,
                numbering: numberingData // [FIXED] Pass numbering data on full update
            };
        } else {
            // Patch Update
            // 8. Handle Shifts (Logic is now handled by frontend via `shift`, backend just calculates it)
            // No need to update `lastBlocks` HTML because we don't store it.
            let shift = 0;
            if (diff.end > 0 && insertedHtmls.length !== diff.deleteCount) {
                shift = insertedHtmls.length - diff.deleteCount;
            }

            // 9. Update Cache (Text Only)
            // Splice the text array to match the new state
            this.lastBlockTexts = [
                ...this.lastBlockTexts.slice(0, diff.start),
                ...diff.insertedTexts,
                ...this.lastBlockTexts.slice(this.lastBlockTexts.length - diff.end)
            ];

            // 10. Dirty Blocks (Bibliography update)
            const dirtyBlocksMap: { [index: number]: string } = {};
            if (keysChanged) {
                // Find bib block in the NEW state (this.lastBlockTexts is already updated)
                const bibBlockIndex = this.lastBlockTexts.findIndex(text => /\\bibliography\{/.test(text));

                // Only update if it exists and wasn't just inserted in this patch (to avoid double rendering)
                const isInsideMainPatch = bibBlockIndex >= diff.start && bibBlockIndex < (diff.start + insertedHtmls.length);

                if (bibBlockIndex !== -1 && !isInsideMainPatch) {
                    const newHtml = this.renderBlockToHtml(this.lastBlockTexts[bibBlockIndex], bibBlockIndex);
                    dirtyBlocksMap[bibBlockIndex] = newHtml;
                }
            }

            payload = {
                type: 'patch',
                start: diff.start,
                deleteCount: diff.deleteCount,
                htmls: insertedHtmls,
                shift: shift,
                numbering: numberingData, // [FIXED] Pass numbering data
                dirtyBlocks: dirtyBlocksMap
            };
        }

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

    private restoreRenderedMath(html: string): string {
        return html.replace(/OOSNAPTEXMATH(\d+)OO/g, (match, index) => {
            const i = parseInt(index, 10);
            let rendered = this.protectedRenderedBlocks[i] || match;
            return rendered.replace(/SNREF(\d+)END/g, (m, refIdx) => {
                const key = this.protectedRefs[parseInt(refIdx)];
                if (!key) { return m; }
                return `<a href="#${key}" class="sn-ref" data-key="${key}" style="color:inherit; text-decoration:none;">?</a>`;
            });
        });
    }

    private restoreRawBlocks(html: string): string {
        return html.replace(/OOSNAPTEXRAW(\d+)OO/g, (match, index) => {
            const i = parseInt(index, 10);
            return this.protectedRawBlocks[i] || match;
        });
    }

    // --- Synchronization Logic (Unified in Step 4) ---

    /**
     * [STEP 4] Unified Preview Synchronization
     * Calculates the target block in the preview for a given source line.
     * * @param filePath Absolute path of the source file.
     * @param line Zero-based line number in the source file.
     * @returns Object containing block index and ratio, or null if mapping fails.
     */
    public getPreviewSyncData(filePath: string, line: number): { index: number; ratio: number } | null {
        if (!this.currentDocument) { return null; }

        // 1. Map source line to flat flattened line (handling imports)
        const flatLine = this.currentDocument.getFlattenedLine(filePath, line);
        if (flatLine === -1) { return null; }

        // 2. Map flattened line to block index
        return this.getBlockIndexByLine(flatLine);
    }

    /**
     * [STEP 4] Unified Source Synchronization
     * Calculates the source location for a given preview block and ratio.
     * * @param blockIndex Index of the block in the preview.
     * @param ratio Vertical ratio within the block (0.0 to 1.0).
     * @returns SourceLocation object or null if mapping fails.
     */
    public getSourceSyncData(blockIndex: number, ratio: number): SourceLocation | null {
        if (!this.currentDocument) { return null; }

        // 1. Map block index to flattened line
        const flatLine = this.getLineByBlockIndex(blockIndex, ratio);

        // 2. Map flattened line back to original source location
        return this.currentDocument.getOriginalPosition(flatLine) || null;
    }

    // Internal helpers (kept public if strictly needed for tests, but main logic should use above methods)

    public getBlockIndexByLine(line: number): { index: number; ratio: number } {
        if (this.blockMap.length > 0 && line < this.blockMap[0].start) {
            return { index: 0, ratio: 0 };
        }
        for (let i = 0; i < this.blockMap.length; i++) {
            const block = this.blockMap[i];
            const nextBlockStart = (i + 1 < this.blockMap.length) ? this.blockMap[i+1].start : Infinity;
            if (line >= block.start && line < nextBlockStart) {
                const offset = line - block.start;
                const count = Math.max(1, block.count);
                const ratio = Math.max(0, Math.min(1, offset / count));
                return { index: i, ratio };
            }
        }
        return { index: this.blockMap.length - 1, ratio: 0 };
    }

    public getLineByBlockIndex(index: number, ratio: number = 0): number {
        if (index >= 0 && index < this.blockMap.length) {
            const block = this.blockMap[index];
            const offset = Math.floor(block.count * ratio);
            return block.start + offset;
        }
        return 0;
    }

    // Forwarding delegates to Document (Legacy support, though internal methods are preferred)
    public getOriginalPosition(flatLine: number): SourceLocation | undefined {
        return this.currentDocument?.getOriginalPosition(flatLine);
    }

    public getFlattenedLine(fsPath: string, originalLine: number): number {
        return this.currentDocument ? this.currentDocument.getFlattenedLine(fsPath, originalLine) : -1;
    }
}