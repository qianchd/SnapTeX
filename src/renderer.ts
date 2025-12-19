import MarkdownIt from 'markdown-it';
const mdKatex = require('@iktakahiro/markdown-it-katex');
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
        // 初始化时加载默认规则
        this._preprocessRules = [...DEFAULT_PREPROCESS_RULES];
        this._sortRules();
    }

    public rebuildMarkdownEngine(macros: Record<string, string>) {
        this.md = new MarkdownIt({ html: true, linkify: true });
        this.md.use(mdKatex, { macros, globalGroup: true, throwOnError: false });
    }

    public resetState() {
        this.lastBlocks = [];
        this.lastMacrosJson = "";
    }

    // --- 供 Rules 调用的端口 ---
    public pushInlineProtected(content: string) {
        this.protectedBlocks.push(content);
        return `%%%PROTECTED_BLOCK_${this.protectedBlocks.length - 1}%%%`;
    }

    public pushDisplayProtected(content: string) {
        this.protectedBlocks.push(content);
        return `\n\n%%%PROTECTED_BLOCK_${this.protectedBlocks.length - 1}%%%\n\n`;
    }

    public toRoman(num: number, uppercase: boolean): string {
        return toRoman(num, uppercase);
    }

    public extractAndHideLabels(content: string) {
        const labels: string[] = [];
        const cleanContent = content.replace(/\\label\{([^}]+)\}/g, (match, labelName) => {
            const safeLabel = labelName.replace(/"/g, '&quot;');
            labels.push(`<span id="${safeLabel}" class="latex-label-anchor" data-label="${safeLabel}" style="display:none"></span>`);
            return '';
        });
        return { cleanContent, hiddenHtml: labels.join('') };
    }

    public registerPreprocessRule(rule: PreprocessRule) {
        // 如果已存在同名规则则替换，否则新增
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


    public render(fullText: string): PatchPayload {
        const normalizedText = fullText.replace(/\r\n/g, '\n');

        // 1. 全局元数据扫描
        const { data, cleanedText } = extractMetadata(normalizedText);

        // 2. 宏更新判断
        const currentMacrosJson = JSON.stringify(data.macros);
        if (currentMacrosJson !== this.lastMacrosJson) {
            this.rebuildMarkdownEngine(data.macros);
            this.lastBlocks = [];
            this.lastMacrosJson = currentMacrosJson;
        }
        this.currentTitle = data.title;
        this.currentAuthor = data.author;

        // 3. 截取正文
        let bodyText = cleanedText;
        const docStartRegex = /\\begin\{document\}/i;
        const docMatch = cleanedText.match(docStartRegex);
        if (docMatch && docMatch.index !== undefined) {
            bodyText = cleanedText.substring(docMatch.index + docMatch[0].length)
                                  .replace(/\\end\{document\}[\s\S]*/i, '');
        }

        // 4. 指纹注入与分块
        const metaFingerprint = `[meta:${data.title || ''}|${data.author || ''}]`;
        const rawBlocks = LatexBlockSplitter.split(bodyText)
            .map(t => t.trim())
            .filter(t => t.length > 0)
            .map(t => t.includes('\\maketitle') ? (t + metaFingerprint) : t);

        // 5. 增量对比 (Diff)
        let start = 0;
        const oldBlocks = this.lastBlocks;
        const minLen = Math.min(rawBlocks.length, oldBlocks.length);
        while (start < minLen && rawBlocks[start] === oldBlocks[start].text) {
            start++;
        }

        let end = 0;
        const maxEnd = Math.min(oldBlocks.length - start, rawBlocks.length - start);
        while (end < maxEnd) {
            if (oldBlocks[oldBlocks.length - 1 - end].text !== rawBlocks[rawBlocks.length - 1 - end]) {break;}
            end++;
        }

        // 6. 渲染变化的部分
        const deleteCount = oldBlocks.length - start - end;
        const rawInsertTexts = rawBlocks.slice(start, rawBlocks.length - end);

        const insertedBlocksData = rawInsertTexts.map(text => {
            this.protectedBlocks = [];
            let processed = text;

            // 循环执行动态注册的规则链
            this._preprocessRules.forEach(rule => {
                processed = rule.apply(processed, this);
            });

            // 2. 还原保护块 (Unmask)
            processed = processed.replace(/%%%PROTECTED_BLOCK_(\d+)%%%/g, (_, index) => {
                return this.protectedBlocks[parseInt(index)];
            });

            // 3. 【核心修复】自动检测是否包含特殊块标记
            const hasSpecialBlocks = /%%%(ABSTRACT|KEYWORDS)_START%%%/.test(processed);

            // 4. 执行 Markdown 渲染并按需执行后处理
            const innerHtml = this.md!.render(processed);
            const finalHtml = hasSpecialBlocks ? postProcessHtml(innerHtml) : innerHtml;

            return {
                text,
                html: `<div class="latex-block">${finalHtml}</div>`
            };
        });

        // 7. 更新状态缓存
        this.lastBlocks = [
            ...oldBlocks.slice(0, start),
            ...insertedBlocksData,
            ...oldBlocks.slice(oldBlocks.length - end)
        ];

        // 判定全量重绘还是增量 Patch
        if (oldBlocks.length === 0 || insertedBlocksData.length > 50) {
            return { type: 'full', html: this.lastBlocks.map(b => b.html).join('') };
        }

        return { type: 'patch', start, deleteCount, htmls: insertedBlocksData.map(b => b.html) };
    }
}