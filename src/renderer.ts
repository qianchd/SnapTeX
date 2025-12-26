import MarkdownIt from 'markdown-it';
const katex = require('katex');
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { extractMetadata } from './metadata';
import { LatexBlockSplitter, BlockResult } from './splitter';
import { PreprocessRule, PatchPayload, SourceLocation } from './types';
import { DEFAULT_PREPROCESS_RULES, postProcessHtml } from './rules';
import { LatexCounterScanner, ScanResult } from './scanner';
import { BibTexParser, BibEntry } from './bib';

export class SmartRenderer {
    private lastBlocks: { text: string, html: string }[] = [];
    private lastMacrosJson: string = "";
    public currentTitle: string | undefined;
    public currentAuthor: string | undefined;
    public currentDate: string | undefined;
    private md: MarkdownIt | null = null;

    // Stores pre-rendered HTML (Math)
    private protectedRenderedBlocks: string[] = [];
    // Stores raw protected text
    private protectedRawBlocks: string[] = [];
    // Stores ref keys to avoid passing complex strings to KaTeX
    private protectedRefs: string[] = [];

    private _preprocessRules: PreprocessRule[] = [];
    private currentMacros: Record<string, string> = {};

    private blockMap: { start: number; count: number }[] = [];
    private contentStartLineOffset: number = 0;

    public bibEntries: Map<string, BibEntry> = new Map();
    public citedKeys: string[] = []; // Tracks order of citation

    // Cache for the last cited keys to detect changes
    private lastCitedKeys: string[] = [];

    private currentDocDir: string = '';

    // Scanner instance
    private scanner = new LatexCounterScanner();

    public globalLabelMap: Record<string, string> = {};

    // Source Map: Maps flattened line index -> original file & line
    private sourceMap: SourceLocation[] = [];

    constructor() {
        this.rebuildMarkdownEngine({});
        this.reloadAllRules();
    }

    public rebuildMarkdownEngine(macros: Record<string, string>) {
        this.currentMacros = {
            "\\mathparagraph": "\\P",
            "\\mathsection": "\\S",
            ...macros
        };
        this.md = new MarkdownIt({ html: true, linkify: true });
        this.md.disable('code');
    }

    public renderInline(text: string): string {
        if (!this.md) { return text; }
        return this.md.renderInline(text);
    }

    public resetState() {
        this.lastBlocks = [];
        this.lastMacrosJson = "";
        this.blockMap = [];
        this.bibEntries.clear();
        this.citedKeys = [];
        this.lastCitedKeys = [];
        this.sourceMap = [];
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
                    userConfig.rules.forEach((rule: PreprocessRule) => {
                        this.registerPreprocessRule(rule);
                    });
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

    private loadBibliography(text: string) {
        const match = text.match(/\\bibliography\{([^}]+)\}/);
        if (match && this.currentDocDir) {
            let bibFile = match[1].trim();
            if (!bibFile.endsWith('.bib')) { bibFile += '.bib'; }

            const bibPath = path.join(this.currentDocDir, bibFile);
            if (fs.existsSync(bibPath)) {
                try {
                    const content = fs.readFileSync(bibPath, 'utf-8');
                    this.bibEntries = BibTexParser.parse(content);
                } catch (e) {
                    console.error('Failed to load bib file:', e);
                }
            }
        } else {
            this.bibEntries.clear();
        }
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
     * Robust Regex for scanning citations
     */
    private scanCitations(blocks: string[]) {
        blocks.forEach(text => {
            // Regex defined inside loop to avoid statefulness issues with /g
            const citeRegex = /\\(cite|citep|citet|citeyear)(?:\*?)(?:\s*\[[^\]]*\]){0,2}\s*\{([^}]+)\}/g;
            let match;
            while ((match = citeRegex.exec(text)) !== null) {
                const keys = match[2].split(',').map(k => k.trim());
                keys.forEach(key => this.resolveCitation(key));
            }
        });
    }

    /**
     * Helper: Extract citation keys from a text fragment.
     */
    private extractKeysFromText(text: string): Set<string> {
        const keys = new Set<string>();
        const regex = /\\(?:cite|citep|citet|citeyear)(?:\*?)(?:\s*\[[^\]]*\]){0,2}\s*\{([^}]+)\}/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const keyParts = match[1].split(',');
            keyParts.forEach(k => keys.add(k.trim()));
        }
        return keys;
    }

    private _sortRules() {
        this._preprocessRules.sort((a, b) => a.priority - b.priority);
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

    private resolvePath(currentDir: string, relPath: string): string {
        let target = path.isAbsolute(relPath) ? relPath : path.join(currentDir, relPath);
        if (!path.extname(target)) { target += '.tex'; }
        return target;
    }

    /**
     * Recursively loads file content and builds a line-by-line source map.
     * @param contentOverride If provided, use this string instead of reading from disk (for root file).
     */
    private loadAndFlatten(filePath: string, depth: number = 0, contentOverride?: string): { textLines: string[], map: SourceLocation[] } {
        const fallback = { textLines: [], map: [] };
        if (depth > 20) { return fallback; } // Recursion limit

        let content = "";

        // [FIX] Use live editor content if provided
        if (contentOverride !== undefined) {
            content = contentOverride;
        } else {
            if (!fs.existsSync(filePath)) {
                return { textLines: [`% [SnapTeX] File not found: ${filePath}`], map: [{ file: filePath, line: 0 }] };
            }
            try {
                content = fs.readFileSync(filePath, 'utf-8');
            } catch (e) {
                return { textLines: [`% [SnapTeX] Error reading: ${filePath}`], map: [{ file: filePath, line: 0 }] };
            }
        }

        const rawLines = content.split(/\r?\n/);
        const flattenedLines: string[] = [];
        const sourceMap: SourceLocation[] = [];

        const inputRegex = /^(\s*)(?:\\input|\\include)\{([^}]+)\}/;

        for (let i = 0; i < rawLines.length; i++) {
            const line = rawLines[i];
            const trimmed = line.trim();

            if (trimmed.startsWith('%')) {
                flattenedLines.push(line);
                sourceMap.push({ file: filePath, line: i });
                continue;
            }

            const match = line.match(inputRegex);
            if (match) {
                const relPath = match[2];
                const targetPath = this.resolvePath(path.dirname(filePath), relPath);

                // Recursively load subfile (no override for children)
                const result = this.loadAndFlatten(targetPath, depth + 1);

                flattenedLines.push(...result.textLines);
                sourceMap.push(...result.map);
            } else {
                flattenedLines.push(line);
                sourceMap.push({ file: filePath, line: i });
            }
        }

        return { textLines: flattenedLines, map: sourceMap };
    }

    public getOriginalPosition(flatLine: number): SourceLocation | undefined {
        if (flatLine >= 0 && flatLine < this.sourceMap.length) {
            return this.sourceMap[flatLine];
        }
        return undefined;
    }

    public getFlattenedLine(fsPath: string, originalLine: number): number {
        const normPath = path.normalize(fsPath);
        let bestLine = -1;
        let minDiff = Infinity;

        for (let i = 0; i < this.sourceMap.length; i++) {
            const loc = this.sourceMap[i];
            if (path.normalize(loc.file) === normPath) {
                const diff = Math.abs(loc.line - originalLine);
                if (diff < minDiff) {
                    minDiff = diff;
                    bestLine = i;
                }
                if (diff === 0) {return i;}
            }
        }
        return bestLine;
    }

    public render(fullText: string, docPath?: string): PatchPayload {
        this.protectedRenderedBlocks = [];
        this.protectedRawBlocks = [];
        this.sourceMap = [];

        let currentCitedKeys: string[] = [];

        if (docPath) {
            this.currentDocDir = path.dirname(docPath);
        }

        let flattenedText = fullText;

        // Pass fullText (dirty content) as override for the root doc
        if (docPath) {
            const result = this.loadAndFlatten(docPath, 0, fullText);
            flattenedText = result.textLines.join('\n');
            this.sourceMap = result.map;
        } else {
            // Fallback for unsaved files
            const lines = fullText.split(/\r?\n/);
            flattenedText = lines.join('\n');
            this.sourceMap = lines.map((_, i) => ({ file: docPath || 'Untitled', line: i }));
        }

        const normalizedText = flattenedText.replace(/\r\n/g, '\n');
        const { data, cleanedText } = extractMetadata(normalizedText);

        this.loadBibliography(cleanedText);

        const currentMacrosJson = JSON.stringify(data.macros);
        if (currentMacrosJson !== this.lastMacrosJson) {
            this.rebuildMarkdownEngine(data.macros);
            this.lastBlocks = [];
            this.lastMacrosJson = currentMacrosJson;
        }
        this.currentTitle = data.title;
        this.currentAuthor = data.author;
        this.currentDate = data.date;

        let bodyText = cleanedText;
        this.contentStartLineOffset = 0;
        const rawDocMatch = normalizedText.match(/\\begin\{document\}/i);
        if (rawDocMatch && rawDocMatch.index !== undefined) {
            const preContent = normalizedText.substring(0, rawDocMatch.index + rawDocMatch[0].length);
            this.contentStartLineOffset = preContent.split('\n').length - 1;
            const cleanDocMatch = cleanedText.match(/\\begin\{document\}/i);
            if (cleanDocMatch && cleanDocMatch.index !== undefined) {
                bodyText = cleanedText.substring(cleanDocMatch.index + cleanDocMatch[0].length)
                    .replace(/\\end\{document\}[\s\S]*/i, '');
            }
        }

        const rawBlockObjects = LatexBlockSplitter.split(bodyText);
        const validBlockObjects = rawBlockObjects.filter(b => b.text.trim().length > 0);
        this.buildBlockMap(validBlockObjects);

        const rawBlocks = validBlockObjects.map(b => b.text.trim());
        const safeAuthor = (data.author || '').replace(/[\r\n]/g, ' ');
        const metaFingerprint = ` [meta:${data.title || ''}|${safeAuthor}|${data.date}]`;

        const scanResult = this.scanner.scan(rawBlocks);
        this.globalLabelMap = scanResult.labelMap;

        // --- Diff Logic ---
        const newBlockStates = rawBlocks.map((rawText) => {
            const text = rawText.includes('\\maketitle') ? (rawText + metaFingerprint) : rawText;
            return { text, html: '' };
        });

        const oldBlocks = this.lastBlocks;
        let start = 0;
        const minLen = Math.min(newBlockStates.length, oldBlocks.length);
        while (start < minLen && newBlockStates[start].text === oldBlocks[start].text) {
            start++;
        }

        let end = 0;
        const maxEnd = Math.min(oldBlocks.length - start, newBlockStates.length - start);
        while (end < maxEnd) {
            if (oldBlocks[oldBlocks.length - 1 - end].text !== newBlockStates[newBlockStates.length - 1 - end].text) { break; }
            end++;
        }

        const insertedBlocks = newBlockStates.slice(start, newBlockStates.length - end);
        const deletedBlocks = oldBlocks.slice(start, oldBlocks.length - end);

        const insertedText = insertedBlocks.map(b => b.text).join('\n');
        const deletedText = deletedBlocks.map(b => b.text).join('\n');

        // --- Optimized Citation Logic ---
        const bibRegex = /\\bibliography\{([^}]+)\}/;
        const bibChanged = bibRegex.test(insertedText) || bibRegex.test(deletedText);

        let shouldFullScan = false;

        if (bibChanged || this.lastBlocks.length === 0) {
            shouldFullScan = true;
        } else {
            const deletedKeys = this.extractKeysFromText(deletedText);
            const insertedKeys = this.extractKeysFromText(insertedText);

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
            this.scanCitations(rawBlocks);
            currentCitedKeys = [...this.citedKeys];
        } else {
            this.citedKeys = [...this.lastCitedKeys];
            currentCitedKeys = [...this.lastCitedKeys];
        }

        const keysChanged = JSON.stringify(currentCitedKeys) !== JSON.stringify(this.lastCitedKeys);
        this.lastCitedKeys = [...currentCitedKeys];

        // --- Rendering ---
        let deleteCount = oldBlocks.length - start - end;

        let insertedBlocksData = insertedBlocks.map((blockData, i) => {
            const absoluteIndex = start + i;
            let processed = blockData.text;

            this._preprocessRules.forEach(rule => {
                processed = rule.apply(processed, this);
            });

            let finalHtml = this.md!.render(processed);
            finalHtml = this.restoreRenderedMath(finalHtml);
            finalHtml = this.restoreRawBlocks(finalHtml);

            if (finalHtml.includes('OOABSTRACT') || finalHtml.includes('OOKEYWORDS')) {
                finalHtml = postProcessHtml(finalHtml);
            }

            return {
                text: blockData.text,
                html: `<div class="latex-block" data-index="${absoluteIndex}">${finalHtml}</div>`
            };
        });

        // Handle Shifts
        let shift = 0;
        if (end > 0 && insertedBlocksData.length !== deleteCount) {
            shift = insertedBlocksData.length - deleteCount;
            const tailBlocks = oldBlocks.slice(oldBlocks.length - end);
            tailBlocks.forEach((b, i) => {
                const newIdx = start + insertedBlocksData.length + i;
                b.html = b.html.replace(/data-index="\d+"/, `data-index="${newIdx}"`);
            });
        }

        // --- Update Memory ---
        this.lastBlocks = [
            ...oldBlocks.slice(0, start),
            ...insertedBlocksData,
            ...oldBlocks.slice(oldBlocks.length - end)
        ];

        // --- Dirty Blocks (Bibliography) ---
        const dirtyBlocksMap: { [index: number]: string } = {};

        if (keysChanged) {
            const bibBlockIndex = this.lastBlocks.findIndex(b => /\\bibliography\{/.test(b.text));

            if (bibBlockIndex !== -1) {
                const isInsideMainPatch = bibBlockIndex >= start && bibBlockIndex < (start + insertedBlocksData.length);

                if (!isInsideMainPatch) {
                    const bibBlock = this.lastBlocks[bibBlockIndex];
                    let processed = bibBlock.text;
                    this._preprocessRules.forEach(rule => {
                        processed = rule.apply(processed, this);
                    });

                    let newHtml = this.md!.render(processed);
                    newHtml = this.restoreRenderedMath(newHtml);
                    newHtml = this.restoreRawBlocks(newHtml);

                    newHtml = `<div class="latex-block" data-index="${bibBlockIndex}">${newHtml}</div>`;
                    this.lastBlocks[bibBlockIndex].html = newHtml;
                    dirtyBlocksMap[bibBlockIndex] = newHtml;
                }
            }
        }

        // --- Payload ---
        const numberingMap: { [index: number]: any } = {};
        scanResult.blockNumbering.forEach((bn, idx) => {
            const hasCounts = Object.values(bn.counts).some(arr => arr.length > 0);
            if (hasCounts) {
                numberingMap[idx] = bn.counts;
            }
        });

        const payload: PatchPayload = {
            type: 'patch',
            start,
            deleteCount,
            htmls: insertedBlocksData.map(b => b.html),
            shift,
            numbering: {
                blocks: numberingMap,
                labels: scanResult.labelMap
            },
            dirtyBlocks: dirtyBlocksMap
        };

        if (oldBlocks.length === 0 || insertedBlocksData.length > 50 || deleteCount > 50) {
            payload.type = 'full';
            payload.html = this.lastBlocks.map(b => b.html).join('');
        }

        return payload;
    }

    private buildBlockMap(blocks: BlockResult[]) {
        this.blockMap = blocks.map(b => ({
            start: this.contentStartLineOffset + b.line,
            count: b.lineCount
        }));
    }

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
}