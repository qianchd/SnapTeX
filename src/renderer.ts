import MarkdownIt from 'markdown-it';
const mdKatex = require('@iktakahiro/markdown-it-katex');
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os'; // 用于获取系统主目录
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
        // 初始加载所有规则层级
        this.reloadAllRules();
    }

    public rebuildMarkdownEngine(macros: Record<string, string>) {
        this.md = new MarkdownIt({ html: true, linkify: true });
        this.md.disable('code');
        this.md.use(mdKatex, { macros, globalGroup: true, throwOnError: false });
    }

    /**
     * 重置渲染器状态（用于全量刷新）
     */
    public resetState() {
        this.lastBlocks = [];
        this.lastMacrosJson = "";
    }

    /**
     * 核心：按顺序重载所有规则层级
     * 顺序：内置默认 -> 全局自定义 (~/.snaptex.global.js) -> 工作区自定义
     */
    public reloadAllRules(workspaceRoot?: string) {
        // 1. 回归内置默认规则
        this._preprocessRules = [...DEFAULT_PREPROCESS_RULES];

        // 2. 加载全局配置
        const globalConfigPath = path.join(os.homedir(), '.snaptex.global.js');
        this.loadConfig(globalConfigPath);

        // 3. 加载工作区配置
        if (workspaceRoot) {
            const workspaceConfigPath = path.join(workspaceRoot, 'snaptex.config.js');
            this.loadConfig(workspaceConfigPath);
        }

        this._sortRules();
    }

    /**
     * 内部配置文件加载器
     */
    private loadConfig(configPath: string) {
        if (fs.existsSync(configPath)) {
            try {
                // 清除 Node.js 的 require 缓存，确保修改配置后能热重载
                delete require.cache[require.resolve(configPath)];
                const userConfig = require(configPath);
                if (userConfig && Array.isArray(userConfig.rules)) {
                    userConfig.rules.forEach((rule: PreprocessRule) => {
                        this.registerPreprocessRule(rule);
                    });
                }
            } catch (e) {
                console.error(`[TeX Preview] 加载配置文件失败: ${configPath}`, e);
            }
        }
    }

    /**
     * 注册/覆盖预处理规则
     */
    public registerPreprocessRule(rule: PreprocessRule) {
        const index = this._preprocessRules.findIndex(r => r.name === rule.name);
        if (index !== -1) {
            this._preprocessRules[index] = rule;
        } else {
            this._preprocessRules.push(rule);
        }
        // 注册后不立即排序，由外层 reloadAllRules 统一排序以优化性能
    }

    private _sortRules() {
        this._preprocessRules.sort((a, b) => a.priority - b.priority);
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

    // --- 核心渲染流水线 ---
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

        // 4. 指纹注入与逻辑分块
        const safeAuthor = (data.author || '').replace(/[\r\n]/g, ' ');
        const metaFingerprint = ` [meta:${data.title || ''}|${safeAuthor}]`;

        const rawBlocks = LatexBlockSplitter.split(bodyText)
            .map(t => t.trim())
            .filter(t => t.length > 0)
            .map(t => t.includes('\\maketitle') ? (t + metaFingerprint) : t);

        const oldBlocks = this.lastBlocks;

        // 5. 增量对比 (Diff)
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

        // 6. 渲染变化的部分
        const deleteCount = oldBlocks.length - start - end;
        const rawInsertTexts = rawBlocks.slice(start, rawBlocks.length - end);

        const insertedBlocksData = rawInsertTexts.map(text => {
            this.protectedBlocks = []; // 每次渲染新块前重置保护区
            let processed = text;

            // 应用动态排序后的规则链
            this._preprocessRules.forEach(rule => {
                processed = rule.apply(processed, this);
            });

            // 还原保护内容 (Unmask)
            processed = processed.replace(/%%%PROTECTED_BLOCK_(\d+)%%%/g, (_, index) => {
                return this.protectedBlocks[parseInt(index)];
            });

            // 自动检测特殊标记并执行 HTML 后处理
            const hasSpecialBlocks = /%%%(ABSTRACT|KEYWORDS)_START%%%/.test(processed);
            const innerHtml = this.md!.render(processed);
            const finalHtml = hasSpecialBlocks ? postProcessHtml(innerHtml) : innerHtml;

            return { text, html: `<div class="latex-block">${finalHtml}</div>` };
        });

        // 7. 更新状态缓存并生成 Patch 载荷
        this.lastBlocks = [
            ...oldBlocks.slice(0, start),
            ...insertedBlocksData,
            ...oldBlocks.slice(oldBlocks.length - end)
        ];

        // 判定是全量重绘还是增量 Patch
        if (oldBlocks.length === 0 || insertedBlocksData.length > 50 || deleteCount > 50) {
            return { type: 'full', html: this.lastBlocks.map(b => b.html).join('') };
        }

        return { type: 'patch', start, deleteCount, htmls: insertedBlocksData.map(b => b.html) };
    }
}