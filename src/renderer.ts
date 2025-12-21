import MarkdownIt from 'markdown-it';
const mdKatex = require('@iktakahiro/markdown-it-katex');
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { extractMetadata } from './metadata';
import { LatexBlockSplitter, BlockResult } from './splitter';
import { PreprocessRule, PatchPayload } from './types';
import { DEFAULT_PREPROCESS_RULES, postProcessHtml } from './rules';


export class SmartRenderer {
    private lastBlocks: { text: string, html: string }[] = [];
    private lastMacrosJson: string = "";
    public currentTitle: string | undefined;
    public currentAuthor: string | undefined;
    private md: MarkdownIt | null = null;
    private protectedBlocks: string[] = [];
    private _preprocessRules: PreprocessRule[] = [];

    // [New] Stores start line AND line count for each block for ratio calculation
    private blockMap: { start: number; count: number }[] = [];
    private contentStartLineOffset: number = 0;

    constructor() {
        this.rebuildMarkdownEngine({});
        this.reloadAllRules();
    }

    public rebuildMarkdownEngine(macros: Record<string, string>) {
        this.md = new MarkdownIt({ html: true, linkify: true });
        this.md.disable('code');
        this.md.use(mdKatex, { macros, globalGroup: true, throwOnError: false });
    }

    public resetState() {
        this.lastBlocks = [];
        this.lastMacrosJson = "";
        this.blockMap = [];
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

    public pushInlineProtected(content: string) {
        this.protectedBlocks.push(content);
        return `%%%PROTECTED_BLOCK_${this.protectedBlocks.length - 1}%%%`;
    }

    public pushDisplayProtected(content: string) {
        this.protectedBlocks.push(content);
        return `\n\n%%%PROTECTED_BLOCK_${this.protectedBlocks.length - 1}%%%\n\n`;
    }

    public render(fullText: string): PatchPayload {
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
        // Filter out empty blocks
        const validBlockObjects = rawBlockObjects.filter(b => b.text.trim().length > 0);

        // Build the precise mapping with line counts
        this.buildBlockMap(validBlockObjects);

        const rawBlocks = validBlockObjects.map(b => b.text.trim());
        const safeAuthor = (data.author || '').replace(/[\r\n]/g, ' ');
        const metaFingerprint = ` [meta:${data.title || ''}|${safeAuthor}]`;
        const fingerprintedBlocks = rawBlocks.map(t => t.includes('\\maketitle') ? (t + metaFingerprint) : t);

        const oldBlocks = this.lastBlocks;

        let start = 0;
        const minLen = Math.min(fingerprintedBlocks.length, oldBlocks.length);
        while (start < minLen && fingerprintedBlocks[start] === oldBlocks[start].text) {
            start++;
        }

        let end = 0;
        const maxEnd = Math.min(oldBlocks.length - start, fingerprintedBlocks.length - start);
        while (end < maxEnd) {
            if (oldBlocks[oldBlocks.length - 1 - end].text !== fingerprintedBlocks[fingerprintedBlocks.length - 1 - end]) { break; }
            end++;
        }

        let deleteCount = oldBlocks.length - start - end;
        const rawInsertTexts = fingerprintedBlocks.slice(start, fingerprintedBlocks.length - end);

        let insertedBlocksData = rawInsertTexts.map((text, i) => {
            const absoluteIndex = start + i;
            this.protectedBlocks = [];
            let processed = text;

            this._preprocessRules.forEach(rule => {
                processed = rule.apply(processed, this);
            });

            processed = processed.replace(/%%%PROTECTED_BLOCK_(\d+)%%%/g, (_, index) => {
                return this.protectedBlocks[parseInt(index)];
            });

            const hasSpecialBlocks = /%%%(ABSTRACT|KEYWORDS)_START%%%/.test(processed);
            const innerHtml = this.md!.render(processed);
            const finalHtml = hasSpecialBlocks ? postProcessHtml(innerHtml) : innerHtml;

            return { text, html: `<div class="latex-block" data-index="${absoluteIndex}">${finalHtml}</div>` };
        });

        // Handle Shift for non-changing tail blocks (Attribute Patching Optimization)
        let shift = 0;
        if (end > 0 && rawInsertTexts.length !== deleteCount) {
             shift = rawInsertTexts.length - deleteCount;
             const tailBlocks = oldBlocks.slice(oldBlocks.length - end);
             tailBlocks.forEach((b, i) => {
                 const newIdx = start + rawInsertTexts.length + i;
                 b.html = b.html.replace(/data-index="\d+"/, `data-index="${newIdx}"`);
             });
        }

        this.lastBlocks = [
            ...oldBlocks.slice(0, start),
            ...insertedBlocksData,
            ...oldBlocks.slice(oldBlocks.length - end)
        ];

        if (oldBlocks.length === 0 || insertedBlocksData.length > 50 || deleteCount > 50) {
            return { type: 'full', html: this.lastBlocks.map(b => b.html).join('') };
        }

        return { type: 'patch', start, deleteCount, htmls: insertedBlocksData.map(b => b.html), shift };
    }

    private buildBlockMap(blocks: BlockResult[]) {
        this.blockMap = blocks.map(b => ({
            start: this.contentStartLineOffset + b.line,
            count: b.lineCount
        }));
    }

    // [New] Expose detailed block info for text searching (Anchor)
    public getBlockInfo(index: number): { start: number; count: number } | undefined {
        if (index >= 0 && index < this.blockMap.length) {
            return this.blockMap[index];
        }
        return undefined;
    }

    /**
     * Return index AND relative ratio (0.0 - 1.0)
     */
    public getBlockIndexByLine(line: number): { index: number; ratio: number } {
        // Find the block containing the line
        for (let i = 0; i < this.blockMap.length; i++) {
            const block = this.blockMap[i];
            const nextBlockStart = (i + 1 < this.blockMap.length) ? this.blockMap[i+1].start : Infinity;

            // If line is within this block
            if (line >= block.start && line < nextBlockStart) {
                // Calculate ratio: how far into the block is this line?
                const offset = line - block.start;
                const count = Math.max(1, block.count);
                const ratio = Math.max(0, Math.min(1, offset / count));

                return { index: i, ratio };
            }
        }
        // Fallback to last block
        return { index: this.blockMap.length - 1, ratio: 0 };
    }

    /**
     * Calculate exact line from block index + ratio
     */
    public getLineByBlockIndex(index: number, ratio: number = 0): number {
        if (index >= 0 && index < this.blockMap.length) {
            const block = this.blockMap[index];
            const offset = Math.floor(block.count * ratio);
            return block.start + offset;
        }
        return 0;
    }
}