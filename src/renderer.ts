import MarkdownIt from 'markdown-it';
const katex = require('katex');
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import { LatexDocument } from './document';
import { DiffEngine } from './diff';
import { PreprocessRule, PatchPayload, SourceLocation } from './types';
import { DEFAULT_PREPROCESS_RULES, postProcessHtml } from './rules';
import { LatexCounterScanner, ScanResult } from './scanner';
import { BibEntry } from './bib';
import { R_CITATION, R_BIBLIOGRAPHY } from './patterns';

/**
 * Renderer Service.
 * Coordinates the Document Model, Diff Engine, and Markdown Rendering.
 */
export class SmartRenderer {
    // State: Cache for the last rendered state (for diffing)
    private lastBlocks: { text: string, html: string }[] = [];
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

    constructor() {
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
        if (fs.existsSync(configPath)) {
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
        this.lastBlocks = [];
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

    public render(doc: LatexDocument): PatchPayload {
        this.currentDocument = doc;
        this.protectedRenderedBlocks = [];
        this.protectedRawBlocks = [];

        // 1. Check for macro updates
        const currentMacrosJson = JSON.stringify(doc.metadata.macros);
        if (currentMacrosJson !== this.lastMacrosJson) {
            this.rebuildMarkdownEngine(doc.metadata.macros);
            this.lastBlocks = [];
            this.lastMacrosJson = currentMacrosJson;
        }

        // 2. Prepare text blocks for Diffing
        const safeAuthor = (this.currentAuthor || '').replace(/[\r\n]/g, ' ');
        const metaFingerprint = ` [meta:${this.currentTitle || ''}|${safeAuthor}|${this.currentDate}]`;

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

        // 5. Diff Computation
        const oldBlockTexts = this.lastBlocks.map(b => b.text);
        const diff = DiffEngine.compute(oldBlockTexts, newBlockTexts);

        // 6. Citation Analysis
        const insertedFullText = diff.insertedTexts.join('\n');
        const deletedFullText = diff.deletedTexts.join('\n');
        const bibRegex = R_BIBLIOGRAPHY;
        const bibChanged = bibRegex.test(insertedFullText) || bibRegex.test(deletedFullText);

        let shouldFullScan = false;

        if (bibChanged || this.lastBlocks.length === 0) {
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
        const insertedBlocksData = diff.insertedTexts.map((text, i) => {
            const absoluteIndex = diff.start + i;
            let processed = text;
            this._preprocessRules.forEach(rule => { processed = rule.apply(processed, this); });
            let finalHtml = this.md!.render(processed);
            finalHtml = this.restoreRenderedMath(finalHtml);
            finalHtml = this.restoreRawBlocks(finalHtml);
            if (finalHtml.includes('OOABSTRACT') || finalHtml.includes('OOKEYWORDS')) {
                finalHtml = postProcessHtml(finalHtml);
            }
            return {
                text: text,
                html: `<div class="latex-block" data-index="${absoluteIndex}">${finalHtml}</div>`
            };
        });

        // 8. Handle Shifts
        let shift = 0;
        if (diff.end > 0 && insertedBlocksData.length !== diff.deleteCount) {
            shift = insertedBlocksData.length - diff.deleteCount;
            const tailBlocks = this.lastBlocks.slice(this.lastBlocks.length - diff.end);
            tailBlocks.forEach((b, i) => {
                const newIdx = diff.start + insertedBlocksData.length + i;
                b.html = b.html.replace(/data-index="\d+"/, `data-index="${newIdx}"`);
            });
        }

        // 9. Update Cache
        this.lastBlocks = [
            ...this.lastBlocks.slice(0, diff.start),
            ...insertedBlocksData,
            ...this.lastBlocks.slice(this.lastBlocks.length - diff.end)
        ];

        // 10. Dirty Blocks (Partial updates for Bibliography)
        const dirtyBlocksMap: { [index: number]: string } = {};
        if (keysChanged) {
            const bibBlockIndex = this.lastBlocks.findIndex(b => /\\bibliography\{/.test(b.text));
            const isInsideMainPatch = bibBlockIndex >= diff.start && bibBlockIndex < (diff.start + insertedBlocksData.length);
            if (bibBlockIndex !== -1 && !isInsideMainPatch) {
                const bibBlock = this.lastBlocks[bibBlockIndex];
                let processed = bibBlock.text;
                this._preprocessRules.forEach(rule => { processed = rule.apply(processed, this); });
                let newHtml = this.md!.render(processed);
                newHtml = this.restoreRenderedMath(newHtml);
                newHtml = this.restoreRawBlocks(newHtml);
                newHtml = `<div class="latex-block" data-index="${bibBlockIndex}">${newHtml}</div>`;
                this.lastBlocks[bibBlockIndex].html = newHtml;
                dirtyBlocksMap[bibBlockIndex] = newHtml;
            }
        }

        // 11. Payload
        const numberingMap: { [index: number]: any } = {};
        scanResult.blockNumbering.forEach((bn, idx) => {
            if (Object.values(bn.counts).some(arr => arr.length > 0)) {
                numberingMap[idx] = bn.counts;
            }
        });

        const payload: PatchPayload = {
            type: 'patch',
            start: diff.start,
            deleteCount: diff.deleteCount,
            htmls: insertedBlocksData.map(b => b.html),
            shift: shift,
            numbering: {
                blocks: numberingMap,
                labels: scanResult.labelMap
            },
            dirtyBlocks: dirtyBlocksMap
        };

        if (this.lastBlocks.length === 0 || insertedBlocksData.length > 50 || diff.deleteCount > 50) {
            payload.type = 'full';
            payload.html = this.lastBlocks.map(b => b.html).join('');
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
                if (!key) {return m;}
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

    // --- Sync Scroll Helpers & Delegates (Fixed for Extension Compatibility) ---

    public getBlockInfo(index: number): { start: number; count: number } | undefined {
        if (index >= 0 && index < this.blockMap.length) {
            return this.blockMap[index];
        }
        return undefined;
    }

    public getBlockIndexByLine(line: number): { index: number; ratio: number } {
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

    // [FIX] Proxy methods: Forward to Document to satisfy extension.ts calls
    public getOriginalPosition(flatLine: number): SourceLocation | undefined {
        return this.currentDocument?.getOriginalPosition(flatLine);
    }

    public getFlattenedLine(fsPath: string, originalLine: number): number {
        return this.currentDocument ? this.currentDocument.getFlattenedLine(fsPath, originalLine) : -1;
    }
}