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

    // [New] Stores the starting line number for each block
    private blockLineMap: number[] = [];
    // [New] Line offset for the main content
    private contentStartLineOffset: number = 0;

    constructor() {
        this.rebuildMarkdownEngine({});
        // Initial load of all rule levels
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
        this.blockLineMap = [];
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

    // --- Core Rendering Pipeline ---
    public render(fullText: string): PatchPayload {
        const normalizedText = fullText.replace(/\r\n/g, '\n');

        // 1. Global metadata scanning
        const { data, cleanedText } = extractMetadata(normalizedText);

        // 2. Macro update
        const currentMacrosJson = JSON.stringify(data.macros);
        if (currentMacrosJson !== this.lastMacrosJson) {
            this.rebuildMarkdownEngine(data.macros);
            this.lastBlocks = [];
            this.lastMacrosJson = currentMacrosJson;
        }
        this.currentTitle = data.title;
        this.currentAuthor = data.author;

        // 3. Extract body text & Calculate content offset
        let bodyText = cleanedText;
        this.contentStartLineOffset = 0;

        // Use normalizedText (Original) to calculate offset
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

        // 4. Split and Map (Now uses exact line numbers from Splitter)
        const rawBlockObjects = LatexBlockSplitter.split(bodyText);

        // Filter out empty blocks if any (trim check)
        const validBlockObjects = rawBlockObjects.filter(b => b.text.trim().length > 0);

        // Build the precise mapping
        this.buildBlockLineMap(validBlockObjects);

        const rawBlocks = validBlockObjects.map(b => b.text.trim());
        const safeAuthor = (data.author || '').replace(/[\r\n]/g, ' ');
        const metaFingerprint = ` [meta:${data.title || ''}|${safeAuthor}]`;
        const fingerprintedBlocks = rawBlocks.map(t => t.includes('\\maketitle') ? (t + metaFingerprint) : t);

        const oldBlocks = this.lastBlocks;

        // 5. Diff
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

        // 6. Render
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

        // [Optimized for No-Jitter]
        // Instead of re-sending the whole tail (which causes scroll jitter),
        // we calculate the shift and update our cache in-memory,
        // but tell the frontend to just update attributes.
        let shift = 0;
        if (end > 0 && rawInsertTexts.length !== deleteCount) {
             shift = rawInsertTexts.length - deleteCount;

             // Update the cache (lastBlocks) for the tail parts so future diffs are correct
             // We do NOT add them to insertedBlocksData to avoid heavy DOM thrashing
             const tailBlocks = oldBlocks.slice(oldBlocks.length - end);
             tailBlocks.forEach((b, i) => {
                 // Update the data-index in the cached HTML string
                 // The new index is: start + rawInsertTexts.length + i
                 const newIdx = start + rawInsertTexts.length + i;
                 // Regex replace the old index with the new one
                 b.html = b.html.replace(/data-index="\d+"/, `data-index="${newIdx}"`);
             });
        }

        // 7. Update Cache
        this.lastBlocks = [
            ...oldBlocks.slice(0, start),
            ...insertedBlocksData,
            ...oldBlocks.slice(oldBlocks.length - end)
        ];

        if (oldBlocks.length === 0 || insertedBlocksData.length > 50 || deleteCount > 50) {
            return { type: 'full', html: this.lastBlocks.map(b => b.html).join('') };
        }

        // Pass the shift value to the frontend
        return { type: 'patch', start, deleteCount, htmls: insertedBlocksData.map(b => b.html), shift };
    }

    /**
     * [Updated] Build mapping using exact relative line numbers from Splitter
     */
    private buildBlockLineMap(blocks: BlockResult[]) {
        this.blockLineMap = blocks.map(b => this.contentStartLineOffset + b.line);
    }

    public getBlockIndexByLine(line: number): number {
        for (let i = 0; i < this.blockLineMap.length; i++) {
            if (this.blockLineMap[i] > line) {
                return Math.max(0, i - 1);
            }
        }
        return this.blockLineMap.length - 1;
    }

    public getLineByBlockIndex(index: number): number {
        if (index >= 0 && index < this.blockLineMap.length) {
            return this.blockLineMap[index];
        }
        return 0;
    }
}