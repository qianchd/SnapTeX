import MarkdownIt from 'markdown-it';
const mdKatex = require('@iktakahiro/markdown-it-katex');
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os'; // Used to get the system home directory
import { extractMetadata } from './metadata';
import { LatexBlockSplitter } from './splitter';
import { PreprocessRule, PatchPayload } from './types';
import { toRoman } from './utils';
import { DEFAULT_PREPROCESS_RULES, postProcessHtml } from './rules';


export class SmartRenderer {
    private lastBlocks: { text: string, html: string }[] = [];
    private lastMacrosJson: string = "";
    public currentTitle: string | undefined;
    public currentAuthor: string | undefined;
    private md: MarkdownIt | null = null;
    private protectedBlocks: string[] = [];
    private _preprocessRules: PreprocessRule[] = [];

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

    /**
     * Reset renderer state (for full refresh)
     */
    public resetState() {
        this.lastBlocks = [];
        this.lastMacrosJson = "";
    }

    /**
     * Core: Reload all rule levels in order.
     * Order: Built-in defaults -> Global custom (~/.snaptex.global.js) -> Workspace custom
     */
    public reloadAllRules(workspaceRoot?: string) {
        // 1. Revert to built-in default rules
        this._preprocessRules = [...DEFAULT_PREPROCESS_RULES];

        // 2. Load global configuration
        const globalConfigPath = path.join(os.homedir(), '.snaptex.global.js');
        this.loadConfig(globalConfigPath);

        // 3. Load workspace configuration
        if (workspaceRoot) {
            const workspaceConfigPath = path.join(workspaceRoot, 'snaptex.config.js');
            this.loadConfig(workspaceConfigPath);
        }

        this._sortRules();
    }

    /**
     * Internal config file loader
     */
    private loadConfig(configPath: string) {
        if (fs.existsSync(configPath)) {
            try {
                // Clear Node.js require cache to ensure hot reload after config modification
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

    /**
     * Register/Override preprocessing rules
     */
    public registerPreprocessRule(rule: PreprocessRule) {
        const index = this._preprocessRules.findIndex(r => r.name === rule.name);
        if (index !== -1) {
            this._preprocessRules[index] = rule;
        } else {
            this._preprocessRules.push(rule);
        }
        // Do not sort immediately after registration; sort uniformly in the outer reloadAllRules to optimize performance
    }

    private _sortRules() {
        this._preprocessRules.sort((a, b) => a.priority - b.priority);
    }

    // --- Ports for Rules to call ---
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

        // 2. Macro update judgment
        const currentMacrosJson = JSON.stringify(data.macros);
        if (currentMacrosJson !== this.lastMacrosJson) {
            this.rebuildMarkdownEngine(data.macros);
            this.lastBlocks = [];
            this.lastMacrosJson = currentMacrosJson;
        }
        this.currentTitle = data.title;
        this.currentAuthor = data.author;

        // 3. Extract body text
        let bodyText = cleanedText;
        const docStartRegex = /\\begin\{document\}/i;
        const docMatch = cleanedText.match(docStartRegex);
        if (docMatch && docMatch.index !== undefined) {
            bodyText = cleanedText.substring(docMatch.index + docMatch[0].length)
                                  .replace(/\\end\{document\}[\s\S]*/i, '');
        }

        // 4. Fingerprint injection and logical blocking
        const safeAuthor = (data.author || '').replace(/[\r\n]/g, ' ');
        const metaFingerprint = ` [meta:${data.title || ''}|${safeAuthor}]`;

        const rawBlocks = LatexBlockSplitter.split(bodyText)
            .map(t => t.trim())
            .filter(t => t.length > 0)
            .map(t => t.includes('\\maketitle') ? (t + metaFingerprint) : t);

        const oldBlocks = this.lastBlocks;

        // 5. Incremental comparison (Diff)
        let start = 0;
        const minLen = Math.min(rawBlocks.length, oldBlocks.length);
        while (start < minLen && rawBlocks[start] === oldBlocks[start].text) {
            start++;
        }

        let end = 0;
        const maxEnd = Math.min(oldBlocks.length - start, rawBlocks.length - start);
        while (end < maxEnd) {
            if (oldBlocks[oldBlocks.length - 1 - end].text !== rawBlocks[rawBlocks.length - 1 - end]) { break; }
            end++;
        }

        // 6. Render the changed parts
        const deleteCount = oldBlocks.length - start - end;
        const rawInsertTexts = rawBlocks.slice(start, rawBlocks.length - end);

        const insertedBlocksData = rawInsertTexts.map(text => {
            this.protectedBlocks = []; // Reset protected area before rendering each new block
            let processed = text;

            // Apply dynamically sorted rule chain
            this._preprocessRules.forEach(rule => {
                processed = rule.apply(processed, this);
            });

            // Restore protected content (Unmask)
            processed = processed.replace(/%%%PROTECTED_BLOCK_(\d+)%%%/g, (_, index) => {
                return this.protectedBlocks[parseInt(index)];
            });

            // Automatically detect special markers and execute HTML post-processing
            const hasSpecialBlocks = /%%%(ABSTRACT|KEYWORDS)_START%%%/.test(processed);
            const innerHtml = this.md!.render(processed);
            const finalHtml = hasSpecialBlocks ? postProcessHtml(innerHtml) : innerHtml;

            return { text, html: `<div class="latex-block">${finalHtml}</div>` };
        });

        // 7. Update state cache and generate Patch payload
        this.lastBlocks = [
            ...oldBlocks.slice(0, start),
            ...insertedBlocksData,
            ...oldBlocks.slice(oldBlocks.length - end)
        ];

        // Determine whether it is a full redraw or an incremental Patch
        if (oldBlocks.length === 0 || insertedBlocksData.length > 50 || deleteCount > 50) {
            return { type: 'full', html: this.lastBlocks.map(b => b.html).join('') };
        }

        return { type: 'patch', start, deleteCount, htmls: insertedBlocksData.map(b => b.html) };
    }
}