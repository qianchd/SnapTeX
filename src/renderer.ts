import MarkdownIt from 'markdown-it';
// [CHANGE] Remove markdown-it-katex, use katex directly
const katex = require('katex');
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { extractMetadata } from './metadata';
import { LatexBlockSplitter, BlockResult } from './splitter';
import { PreprocessRule, PatchPayload } from './types';
import { DEFAULT_PREPROCESS_RULES, postProcessHtml } from './rules';
import { LatexCounterScanner, ScanResult } from './scanner';

export class SmartRenderer {
    private lastBlocks: { text: string, html: string }[] = [];
    private lastMacrosJson: string = "";
    public currentTitle: string | undefined;
    public currentAuthor: string | undefined;
    private md: MarkdownIt | null = null;

    // Stores pre-rendered HTML (Math)
    private protectedRenderedBlocks: string[] = [];
    // Stores raw protected text
    private protectedRawBlocks: string[] = [];

    private _preprocessRules: PreprocessRule[] = [];
    private currentMacros: Record<string, string> = {};

    private blockMap: { start: number; count: number }[] = [];
    private contentStartLineOffset: number = 0;

    // Scanner instance
    private scanner = new LatexCounterScanner();

    public globalLabelMap: Record<string, string> = {};

    constructor() {
        this.rebuildMarkdownEngine({});
        this.reloadAllRules();
    }

    public rebuildMarkdownEngine(macros: Record<string, string>) {
        this.currentMacros = macros;
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
        // scanner reset is handled inside scanner.scan()
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

    private _sortRules() {
        this._preprocessRules.sort((a, b) => a.priority - b.priority);
    }

    // Token format: OOSNAPTEXRAW...OO
    public pushInlineProtected(content: string) {
        const index = this.protectedRawBlocks.length;
        this.protectedRawBlocks.push(content);
        return `OOSNAPTEXRAW${index}OO`;
    }

    // Token format: OOSNAPTEXMATH...OO
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
            return this.protectedRenderedBlocks[i] || match;
        });
    }

    private restoreRawBlocks(html: string): string {
        return html.replace(/OOSNAPTEXRAW(\d+)OO/g, (match, index) => {
            const i = parseInt(index, 10);
            return this.protectedRawBlocks[i] || match;
        });
    }

    public render(fullText: string): PatchPayload {
        this.protectedRenderedBlocks = [];
        this.protectedRawBlocks = [];

        const normalizedText = fullText.replace(/\r\n/g, '\n');
        const { data, cleanedText } = extractMetadata(normalizedText);

        const currentMacrosJson = JSON.stringify(data.macros);
        if (currentMacrosJson !== this.lastMacrosJson) {
            this.rebuildMarkdownEngine(data.macros);
            this.lastBlocks = [];
            this.lastMacrosJson = currentMacrosJson;
        }
        this.currentTitle = data.title;
        this.currentAuthor = data.author;

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
        const metaFingerprint = ` [meta:${data.title || ''}|${safeAuthor}]`;

        // [FIXED] 1. Scan ALL blocks to get numbering data
        const scanResult = this.scanner.scan(rawBlocks);
        this.globalLabelMap = scanResult.labelMap;

        // 2. Prepare block states for Diffing
        // Since we use placeholders, we ONLY need to compare text content.
        const newBlockStates = rawBlocks.map((rawText, i) => {
            const text = rawText.includes('\\maketitle') ? (rawText + metaFingerprint) : rawText;
            return { text, html: '' };
        });

        const oldBlocks = this.lastBlocks;
        let start = 0;
        const minLen = Math.min(newBlockStates.length, oldBlocks.length);

        // Diffing: Compare text only
        while (start < minLen && newBlockStates[start].text === oldBlocks[start].text) {
            start++;
        }

        let end = 0;
        const maxEnd = Math.min(oldBlocks.length - start, newBlockStates.length - start);
        while (end < maxEnd) {
            if (oldBlocks[oldBlocks.length - 1 - end].text !== newBlockStates[newBlockStates.length - 1 - end].text) { break; }
            end++;
        }

        let deleteCount = oldBlocks.length - start - end;
        const blocksToRender = newBlockStates.slice(start, newBlockStates.length - end);

        let insertedBlocksData = blocksToRender.map((blockData, i) => {
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

        let shift = 0;
        if (end > 0 && blocksToRender.length !== deleteCount) {
             shift = blocksToRender.length - deleteCount;
             const tailBlocks = oldBlocks.slice(oldBlocks.length - end);
             tailBlocks.forEach((b, i) => {
                 const newIdx = start + blocksToRender.length + i;
                 b.html = b.html.replace(/data-index="\d+"/, `data-index="${newIdx}"`);
             });
        }

        this.lastBlocks = [
            ...oldBlocks.slice(0, start),
            ...insertedBlocksData,
            ...oldBlocks.slice(oldBlocks.length - end)
        ];

        // Prepare Numbering Data for Client
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
            }
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