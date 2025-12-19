import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import MarkdownIt = require('markdown-it');
const mdKatex = require('@iktakahiro/markdown-it-katex');

// --- Preamble 数据接口 ---
interface PreambleData {
    macros: Record<string, string>;
    title?: string;
    author?: string;
}

// --- 修改后的元数据接口 ---
interface MetadataResult {
    data: PreambleData;
    cleanedText: string;
}

function extractMetadata(text: string): MetadataResult {
    // 1. 预清洗注释，防止匹配到注释掉的标题
    let cleanedText = text.replace(/(?<!\\)%.*/gm, '');

    let title: string | undefined;
    let author: string | undefined;

    // 2. 提取并移除 \title
    // 使用非贪婪匹配处理嵌套花括号
    const titleRegex = /\\title\{((?:[^{}]|{[^{}]*})*)\}/g;
    cleanedText = cleanedText.replace(titleRegex, (match, content) => {
        title = content.replace(/\\\\/g, '<br/>').trim();
        return ""; // 从文中移除
    });

    // 3. 提取并移除 \author
    const authorRegex = /\\author\{((?:[^{}]|{[^{}]*})*)\}/g;
    cleanedText = cleanedText.replace(authorRegex, (match, content) => {
        author = content.replace(/\\\\/g, '<br/>').trim();
        return ""; // 从文中移除
    });

    // 4. 提取 Macros (保持原有逻辑，但不移除，因为渲染器需要它们)
    const macros: Record<string, string> = {};
    const macroRegex = /\\(newcommand|renewcommand|def|gdef|DeclareMathOperator)(\*?)\s*\{?(\\[a-zA-Z0-9]+)\}?(?:\[(\d+)\])?/g;
    let match;
    while ((match = macroRegex.exec(cleanedText)) !== null) {
        // ... 此处保留你原有的宏提取逻辑代码 ...
        const cmdType = match[1];
        const star = match[2];
        const cmdName = match[3];
        const matchEndIndex = match.index + match[0].length;
        let openBraces = 0, contentStartIndex = -1, contentEndIndex = -1, foundStart = false;

        for (let i = matchEndIndex; i < cleanedText.length; i++) {
            const char = cleanedText[i];
            if (char === '{') {
                if (!foundStart) { contentStartIndex = i + 1; foundStart = true; }
                openBraces++;
            } else if (char === '}') {
                openBraces--;
                if (foundStart && openBraces === 0) { contentEndIndex = i; break; }
            }
        }
        if (contentStartIndex !== -1 && contentEndIndex !== -1) {
            const definition = cleanedText.substring(contentStartIndex, contentEndIndex).trim();
            if (cmdType === 'DeclareMathOperator') {
                macros[cmdName] = star === '*' ? `\\operatorname*{${definition}}` : `\\operatorname{${definition}}`;
            } else {
                macros[cmdName] = definition;
            }
        }
    }

    return {
        data: { macros, title, author },
        cleanedText: cleanedText
    };
}

// --- 分块器 ---
class LatexBlockSplitter {
    public static split(text: string): string[] {
        const blocks: string[] = [];
        let currentBuffer = "";
        let envStack: string[] = [];
        let braceDepth = 0;

        // --- 核心正则 ---
        // 索引说明: 1:\begin, 2:name, 3:\end, 4:name, 5:{, 6:}, 7:双换行, 8:$$|\[|\]
        const regex = /(?:\\\$|\\\{|\\\})|(?:(?<!\\)%.*)|(\\begin\{([^}]+)\})|(\\end\{([^}]+)\})|(\{)|(\})|(\n\s*\n)|(?<!\\)(\$\$|\\\[|\\\])/g;

        let lastIndex = 0;
        let match;

        while ((match = regex.exec(text)) !== null) {
            // 将匹配项之前的普通文本存入 buffer
            currentBuffer += text.substring(lastIndex, match.index);
            const fullMatch = match[0];

            const isBegin = match[1];
            const beginName = match[2];
            const isEnd = match[3];
            const endName = match[4];
            const isOpenBrace = match[5];
            const isCloseBrace = match[6];
            const isDoubleNewline = match[7];
            const isMathSymbol = match[8];

            if (isBegin && beginName) {
                // 【核心修复】: 排除 proof, itemize, enumerate 环境，使其内部可以自由切分
                const isTransparent = /^(proof|itemize|enumerate)$/.test(beginName);
                if (!isTransparent) {
                    // 识别块级数学环境
                    const isMathEnv = /^(equation|align|gather|multline|flalign|alignat)\*?$/.test(beginName);
                    // 如果是数学环境且处于最外层，强制切断前文
                    if (isMathEnv && envStack.length === 0 && braceDepth === 0) {
                        if (currentBuffer.trim().length > 0) {
                            blocks.push(currentBuffer);
                            currentBuffer = "";
                        }
                    }
                    envStack.push(beginName);
                }
                currentBuffer += fullMatch;
            } else if (isEnd && endName) {
                const isTransparent = /^(proof|itemize|enumerate)$/.test(endName);
                if (!isTransparent) {
                    const idx = envStack.lastIndexOf(endName);
                    if (idx !== -1) {
                        envStack = envStack.slice(0, idx);
                    }
                }
                currentBuffer += fullMatch;
            } else if (isOpenBrace) {
                braceDepth++;
                currentBuffer += fullMatch;
            } else if (isCloseBrace) {
                braceDepth--;
                currentBuffer += fullMatch;
            } else if (isDoubleNewline) {
                // 仅在环境外且括号闭合时切分
                if (envStack.length === 0 && braceDepth === 0) {
                    if (currentBuffer.trim().length > 0) {
                        blocks.push(currentBuffer);
                        currentBuffer = "";
                    }
                } else {
                    currentBuffer += fullMatch;
                }
            } else if (isMathSymbol) {
                // 处理 $$ 和 \[ \] 的状态切换
                if (fullMatch === '$$' || fullMatch === '\\[' ) {
                    // 如果当前已经在某个数学环境或括号内部，则不执行块切分，仅作为普通字符记录
                    if (envStack.length === 0 && braceDepth === 0) {
                        // 公式开始：强制切断前文
                        if (currentBuffer.trim().length > 0) {
                            blocks.push(currentBuffer);
                            currentBuffer = "";
                        }
                        // 使用对应的结束符作为栈标记
                        envStack.push(fullMatch === '$$' ? '$$' : '\\]');
                    } else if (envStack.length > 0 && envStack[envStack.length - 1] === '$$' && fullMatch === '$$') {
                        // $$ 闭合
                        envStack.pop();
                    }
                } else if (fullMatch === '\\]') {
                    // \] 闭合
                    if (envStack.length > 0 && envStack[envStack.length - 1] === '\\]') {
                        envStack.pop();
                    }
                }
                currentBuffer += fullMatch;
            } else {
                // 命中转义字符 (\$ 等) 或注释，直接记录
                currentBuffer += fullMatch;
            }
            lastIndex = regex.lastIndex;
        }

        // 存入最后剩余的内容
        currentBuffer += text.substring(lastIndex);
        if (currentBuffer.trim().length > 0) {
            blocks.push(currentBuffer);
        }

        return blocks;
    }
}


interface PatchPayload {
    type: 'full' | 'patch';
    html?: string;
    start?: number;
    deleteCount?: number;
    htmls?: string[];
}

// --- 智能渲染器 ---
class SmartRenderer {
    private lastBlocks: { text: string, html: string }[] = [];
    // 存储上一次的宏定义，用于对比是否需要重载引擎
    private lastMacrosJson: string = "";
    private lastPreambleHash: string = "";
    private currentTitle: string | undefined = undefined;
    private currentAuthor: string | undefined = undefined;
    private md: MarkdownIt | null = null;

    constructor() { this.rebuildMarkdownEngine({}); }

    private toRoman(num: number, uppercase: boolean = false): string {
        const lookup: [string, number][] = [
            ['M', 1000], ['CM', 900], ['D', 500], ['CD', 400],
            ['C', 100], ['XC', 90], ['L', 50], ['XL', 40],
            ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1]
        ];
        let roman = '';
        for (const [letter, value] of lookup) {
            while (num >= value) {
                roman += letter;
                num -= value;
            }
        }
        return uppercase ? roman : roman.toLowerCase();
    }

    private rebuildMarkdownEngine(macros: Record<string, string>) {
        this.md = new MarkdownIt({ html: true, linkify: true, typographer: true });
        this.md.disable('code');
        this.md.use(mdKatex, { macros, globalGroup: true, throwOnError: false, errorColor: '#cc0000' });
    }

    private extractAndHideLabels(content: string): { cleanContent: string, hiddenHtml: string } {
        const labels: string[] = [];
        const cleanContent = content.replace(/\\label\{([^}]+)\}/g, (match, labelName) => {
            const safeLabel = labelName.replace(/"/g, '&quot;');
            labels.push(`<span id="${safeLabel}" class="latex-label-anchor" data-label="${safeLabel}" style="display:none"></span>`);
            return '';
        });
        return { cleanContent: cleanContent, hiddenHtml: labels.join('') };
    }

    private capitalizeFirstLetter(string: string) {
        return string.charAt(0).toUpperCase() + string.slice(1);
    }

    // HTML 后处理：替换占位符
    private postProcessHtml(html: string): string {
        // Abstract
        html = html.replace(/<p>\s*%%%ABSTRACT_START%%%\s*<\/p>/g, '<div class="latex-abstract"><span class="latex-abstract-title">Abstract</span>');
        html = html.replace(/%%%ABSTRACT_START%%%/g, '<div class="latex-abstract"><span class="latex-abstract-title">Abstract</span>');

        html = html.replace(/<p>\s*%%%ABSTRACT_END%%%\s*<\/p>/g, '</div>');
        html = html.replace(/%%%ABSTRACT_END%%%/g, '</div>');

        // Keywords
        html = html.replace(/<p>\s*%%%KEYWORDS_START%%%([\s\S]*?)%%%KEYWORDS_END%%%\s*<\/p>/g, (match, content) => {
            return `<div class="latex-keywords"><strong>Keywords:</strong> ${content}</div>`;
        });
        html = html.replace(/%%%KEYWORDS_START%%%([\s\S]*?)%%%KEYWORDS_END%%%/g, (match, content) => {
            return `<div class="latex-keywords"><strong>Keywords:</strong> ${content}</div>`;
        });

        return html;
    }

    /**
     * 【新增】样式下沉应用器
     * 如果内容中包含 Markdown 列表，则将样式应用到每个列表项的内容上，而不是包裹整个列表。
     * @param startTag HTML 开始标签，如 <span style="color:red">
     * @param endTag HTML 结束标签，如 </span>
     * @param content 需要包裹的内容
     */
    private applyStyleToText(startTag: string, endTag: string, content: string): string {
        // 先按行切分，兼容 \r\n
        const lines = content.split(/\r?\n/);

        // 只有当看起来像包含列表时才启动复杂逻辑
        if (lines.some(line => /^\s*([-*+]|\d+\.)\s/.test(line))) {
            return lines.map(line => {
                // 匹配: (缩进)(标记)(空格)(剩余内容)
                const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);

                if (listMatch) {
                    const [_, indent, bullet, innerText] = listMatch;
                    // 【关键】: indent 和 bullet 在标签外面，innerText 在标签里面
                    // Markdown 才能识别这是列表
                    return `${indent}${bullet} ${startTag}${innerText}${endTag}`;
                } else {
                    const trimmed = line.trim();
                    if (trimmed.length > 0) {
                        return `${startTag}${line}${endTag}`;
                    }
                    return line; // 保持空行原样
                }
            }).join('\n');
        } else {
            // 普通文本，直接包裹
            return `${startTag}${content}${endTag}`;
        }
    }

    // 更新 preprocessLatexMath 方法
    private preprocessLatexMath(text: string): { processedText: string, hasSpecialBlocks: boolean } {
        let hasSpecialBlocks = false;
        const protectedBlocks: string[] = [];

        // --- 辅助函数：保护区管理 ---
        const pushInlineProtected = (content: string) => {
            protectedBlocks.push(content);
            return `%%%PROTECTED_BLOCK_${protectedBlocks.length - 1}%%%`;
        };

        const pushDisplayProtected = (content: string) => {
            protectedBlocks.push(content);
            return `\n\n%%%PROTECTED_BLOCK_${protectedBlocks.length - 1}%%%\n\n`;
        };

        // --- Step 0: 处理转义符 (最优先，防止 \$ 被识别为公式) ---
        text = text.replace(/\\([$%#&])/g, (match, char) => {
            const entities: Record<string, string> = { '$': '&#36;', '#': '&#35;', '&': '&amp;', '%': '&#37;' };
            return pushInlineProtected(entities[char] || char);
        });

        // --- Step 1: 罗马数字与特殊标记 ---
        text = text.replace(/\\(Rmnum|rmnum|romannumeral)\s*\{?(\d+)\}?/g, (match, cmd, numStr) => {
            return this.toRoman(parseInt(numStr), cmd === 'Rmnum');
        });

        text = text.replace(/\\noindent\s*/g, () => pushInlineProtected('<span class="no-indent-marker"></span>'));

        // --- Step 2: 块级数学公式处理 (唯一处理点) ---
        const mathBlockRegex = /(\$\$([\s\S]*?)\$\$)|(\\\[([\s\S]*?)\\\])|(\\begin\{(equation|align|gather|multline|flalign|alignat)(\*?)\}([\s\S]*?)\\end\{\6\7\})/gi;
        text = text.replace(mathBlockRegex, (match, m1, c1, m3, c4, m5, envName, star, c8, offset, fullString) => {
            let content = c1 || c4 || c8 || match;
            const { cleanContent, hiddenHtml } = this.extractAndHideLabels(content);
            let finalMath = cleanContent.trim();

            if (envName) {
                const name = envName.toLowerCase();
                // KaTeX 适配：将某些环境包裹在 aligned/gathered 中
                if (['align', 'flalign', 'alignat', 'multline'].includes(name)) {
                    finalMath = `\\begin{aligned}\n${finalMath}\n\\end{aligned}`;
                } else if (name === 'gather') {
                    finalMath = `\\begin{gathered}\n${finalMath}\n\\end{gathered}`;
                } else if (name === 'equation') {
                    finalMath = finalMath; // 原样保持
                }
            }

            // 注入不缩进检测
            const afterMatch = fullString.substring(offset + match.length);
            const isFollowedByText = /^\s*\S/.test(afterMatch) && !/^\s*\n\n/.test(afterMatch);

            const mathHtml = `$$\n${finalMath}\n$$\n${hiddenHtml}`;
            const protectedTag = pushDisplayProtected(mathHtml);
            return isFollowedByText ? `${protectedTag}<span class="no-indent-marker"></span>` : protectedTag;
        });

        // --- Step 3: 行内公式保护 ---
        text = text.replace(/(\$((?:\\.|[^\\$])*)\$)/gm, (match) => pushInlineProtected(match));

        // --- Step 4: 定理环境处理 ---
        const thmEnvs = ['theorem', 'lemma', 'proposition', 'condition', 'assumption', 'remark', 'definition', 'corollary', 'example'].join('|');
        const thmRegex = new RegExp(`\\\\begin\\{(${thmEnvs})\\}(?:\\[(.*?)\\])?([\\s\\S]*?)\\\\end\\{\\1\\}`, 'gi');

        text = text.replace(thmRegex, (match, envName, optArg, content) => {
                const displayName = this.capitalizeFirstLetter(envName);
                let header = `\n<span class="latex-thm-head"><strong class="latex-theorem-header">${displayName}</strong>`;
                if (optArg) {header += `&nbsp;(${optArg})`;}
                header += `.</span>&nbsp; `;
                return `${header}${content.trim()}\n`;
            });

        // --- Step 5: 证明环境处理 ---
        text = text.replace(/\\begin\{proof\}(?:\[(.*?)\])?/gi, (match, optArg) => {
            const title = optArg ? `Proof (${optArg}).` : `Proof.`;
            return `\n<span class="no-indent-marker"></span>**${title}** `;
        });
        text = text.replace(/\\end\{proof\}/gi, () => ` <span style="float:right;">QED</span>\n`);

        // --- Step 6: 文章元数据与结构 ---
        if (text.includes('\\maketitle')) {
            let titleBlock = '';
            if (this.currentTitle) {titleBlock += `<h1 class="latex-title">${this.currentTitle}</h1>`;}
            if (this.currentAuthor) {titleBlock += `<div class="latex-author">${this.currentAuthor}</div>`;}

            // 即使 title 为空，也要替换掉整个带指纹的字符串，防止指纹露出
            text = text.replace(/\\maketitle.*/g, `\n\n${titleBlock}\n\n`);
        }

        text = text.replace(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/gi, (match, content) => {
            hasSpecialBlocks = true;
            return `\n\n%%%ABSTRACT_START%%%\n\n${content.trim()}\n\n%%%ABSTRACT_END%%%\n\n`;
        });

        text = text.replace(/\\begin\{keywords?\}([\s\S]*?)\\end\{keywords?\}/gi, (match, content) => {
            hasSpecialBlocks = true;
            return `\n\n%%%KEYWORDS_START%%%${content.replace(/\\sep/g, ', ').trim()}%%%KEYWORDS_END%%%\n\n`;
        });

        // --- Step 7: 标题级别解析 ---
        const sectionRegex = /\\(section|subsection|subsubsection)(\*?)\{((?:[^{}]|{[^{}]*})*)\}\s*(\\label\{[^}]+\})?\s*/g;
        text = text.replace(sectionRegex, (match, level, star, content, label) => {
            const prefix = level === 'section' ? '##' : (level === 'subsection' ? '###' : '####');
            let anchor = "";
            if (label) {
                const labelName = label.match(/\{([^}]+)\}/)?.[1] || "";
                anchor = `<span id="${labelName}" class="latex-label-anchor"></span>`;
            }
            return `\n${prefix} ${content.trim()} ${anchor}\n`;
        });

        // Step 8: 浮动体占位符 (优化版)
        text = text.replace(/\\begin\{(figure|table|algorithm)(\*?)\}([\s\S]*?)\\end\{\1\2\}/gi, (match, envName, star, content) => {
            // 1. 对内部源码进行彻底转义，防止控制字符干扰 HTML 结构
            const safeContent = content
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');

            // 2. 使用特定的保护标记，并确保前后有空行，防止 Markdown-It 把 div 塞进 p 标签
            // 使用 \n\n 强制切断上下文
            return `\n\n<div class="latex-float-placeholder" data-env="${envName}">` +
                   `<strong class="float-name">[${envName.toUpperCase()}${star}]</strong>` +
                   `<pre class="float-content">${safeContent.trim()}</pre>` +
                   `</div>\n`;
        });

        // --- Step 9: 列表处理 ---
        const listStack: string[] = [];
        text = text.replace(/(\\begin\{(?:itemize|enumerate)\})|(\\end\{(?:itemize|enumerate)\})|(\\item(?:\[(.*?)\])?)/g, (match, pBegin, pEnd, pItem, pLabel) => {
            if (pBegin) {
                listStack.push(match.includes('itemize') ? 'ul' : 'ol');
                return '\n\n';
            } else if (pEnd) {
                listStack.pop();
                return '\n\n';
            } else if (pItem) {
                const depth = listStack.length;
                const indent = '  '.repeat(Math.max(0, depth - 1));
                const currentType = listStack[listStack.length - 1] || 'ul';
                if (pLabel) {return `\n${indent}- **${pLabel}** `;}
                return `\n${indent}${currentType === 'ul' ? '-' : '1.'} `;
            }
            return match;
        });

        // --- Step 10: 引用与交叉链接 ---
        text = text.replace(/\\label\{([^}]+)\}/g, (match, labelName) => {
            const safeLabel = labelName.replace(/"/g, '&quot;');
            return `<span id="${safeLabel}" class="latex-label-anchor" data-label="${safeLabel}" style="position:relative; top:-50px; visibility:hidden;"></span>`;
        });

        text = text.replace(/\\(ref|eqref|cite|citep|citet)\{([^}]+)\}/g, (match: string, type: string, labels: string): string => {
            // 将逗号分隔的多个标签拆分为数组并去除空格
            const labelArray: string[] = labels.split(',').map((l: string) => l.trim());

            const htmlLinks: string[] = labelArray.map((label: string) => {
                const safeLabel: string = label.replace(/"/g, '&quot;');

                // 逻辑优化：提取冒号后的内容作为显示文本
                // 使用 split(':').pop() || label 确保即使 pop 返回 undefined 也有回退值
                const displayText: string = label.includes(':')
                    ? (label.split(':').pop() || label)
                    : label;

                return `<a href="#${safeLabel}" class="latex-link latex-${type}">${displayText}</a>`;
            });

            const joinedLinks: string = htmlLinks.join(', ');

            // 根据 LaTeX 类型决定是否包裹容器 (用于 CSS 通过 ::before/::after 添加括号)
            if (type === 'citep') {
                return `<span class="latex-citep-container">${joinedLinks}</span>`;
            }
            if (type === 'eqref') {
                return `<span class="latex-eqref-container">${joinedLinks}</span>`;
            }
            return joinedLinks;
        });

        // --- Step 11: 文本样式处理 (命令式 & 作用域式) ---
        // 处理 \textbf{...}
        text = text.replace(/\\(textbf|textit)\{((?:[^{}]|{[^{}]*})*)\}/g, (match, cmd, content) => {
            const tag = cmd === 'textbf' ? 'strong' : 'em';
            return this.applyStyleToText(`<${tag}>`, `</${tag}>`, content);
        });
        // 处理 {\bf ...}
        text = text.replace(/\{\\(bf|it)\s+((?:[^{}]|{[^{}]*})*)\}/g, (match, cmd, content) => {
            const tag = cmd === 'bf' ? 'strong' : 'em';
            return this.applyStyleToText(`<${tag}>`, `</${tag}>`, content);
        });
        // 处理 {\color{...} ...}
        text = text.replace(/\{\\color\{([a-zA-Z0-9]+)\}\s*((?:[^{}]|{[^{}]*})*)\}/g, (match, color, content) => {
            return this.applyStyleToText(`<span style="color: ${color}">`, '</span>', content);
        });

        // --- Step 12: 最终保护区还原 (Unmask) ---
        text = text.replace(/%%%PROTECTED_BLOCK_(\d+)%%%/g, (match, index) => {
            return protectedBlocks[parseInt(index)];
        });

        return { processedText: text, hasSpecialBlocks };
    }

    public resetState() {
        this.lastBlocks = [];
        this.lastPreambleHash = "";
    }

public render(fullText: string): PatchPayload {
        // --- Step 1: 统一换行符 ---
        const normalizedText = fullText.replace(/\r\n/g, '\n');

        // --- Step 2: 全局元数据提取与清洗 ---
        // 这步会获取 title/author 并从 text 中删掉它们
        const { data, cleanedText } = extractMetadata(normalizedText);

        // --- Step 3: 数据驱动的重载判断 ---
        // 不再对比 raw text，而是对比提取出的 macros 对象
        const currentMacrosJson = JSON.stringify(data.macros);
        if (currentMacrosJson !== this.lastMacrosJson) {
            this.rebuildMarkdownEngine(data.macros);
            this.currentTitle = data.title;
            this.currentAuthor = data.author;
            this.lastBlocks = []; // 宏改变，强制重置所有块缓存
            this.lastMacrosJson = currentMacrosJson;
        } else {
            // 即使宏没变，标题和作者可能有微调
            this.currentTitle = data.title;
            this.currentAuthor = data.author;
        }

        // --- Step 4: 截取正文 Body ---
        // 在已经被删掉 title/author 的 cleanedText 中寻找 document 边界
        const docStartRegex = /\\begin\{document\}/i;
        const docMatch = cleanedText.match(docStartRegex);

        let bodyText = "";
        if (docMatch && docMatch.index !== undefined) {
            bodyText = cleanedText.substring(docMatch.index + docMatch[0].length)
                                  .replace(/\\end\{document\}[\s\S]*/i, '');
        } else {
            bodyText = cleanedText;
        }

        // --- Step 5: 分块与增量比对 (保持原有逻辑) ---
        // 【核心技巧】：构造指纹签名
        const metaFingerprint = `[meta:${data.title}|${data.author}]`;

        // 标准化分块，并给 \maketitle 块打上指纹标签
        const rawBlocks = LatexBlockSplitter.split(bodyText)
            .map(t => t.trim())
            .filter(t => t.length > 0)
            .map(t => {
                // 如果块中包含 \maketitle，就强行改变它的文本标识
                // 这样当标题改变时，Diff 算法会认为这个特定的块“变了”
                return t.includes('\\maketitle') ? t + metaFingerprint : t;
            });

        const oldBlocks = this.lastBlocks;

        // --- Step 6. 文本层面的 Diff (对比 text 字段) ---
        let start = 0;
        const minLen = Math.min(rawBlocks.length, oldBlocks.length);
        while (start < minLen && rawBlocks[start] === oldBlocks[start].text) {
            start++;
        }

        let end = 0;
        const maxEnd = Math.min(oldBlocks.length - start, rawBlocks.length - start);
        while (end < maxEnd) {
            const oldIdx = oldBlocks.length - 1 - end;
            const newIdx = rawBlocks.length - 1 - end;
            if (oldBlocks[oldIdx].text !== rawBlocks[newIdx]) {break;}
            end++;
        }

        // if (end < 1) {
        //     console.log(oldBlocks[oldBlocks.length - 1 - end]);
        //     console.log(rawBlocks[rawBlocks.length - 1 - end]);
        // }

        // --- Step 7. 局部渲染 (核心：仅渲染差异部分) ---
        const deleteCount = oldBlocks.length - start - end;
        const rawInsertTexts = rawBlocks.slice(start, rawBlocks.length - end);

        console.log("start", start, "   end", end, "    length", deleteCount, "   ", rawInsertTexts.length);

        // 【关键】只对发生变化的 rawInsertTexts 调用 markdown-it 渲染
        const insertedBlocksData = rawInsertTexts.map(text => {
            const { processedText, hasSpecialBlocks } = this.preprocessLatexMath(text);
            const innerHtml = this.md!.render(processedText);
            const html = `<div class="latex-block">${hasSpecialBlocks ? this.postProcessHtml(innerHtml) : innerHtml}</div>`;
            return { text, html };
        });

        // --- 6. 构造新的状态缓存 ---
        const newBlocksData = [
            ...oldBlocks.slice(0, start),
            ...insertedBlocksData,
            ...oldBlocks.slice(oldBlocks.length - end)
        ];
        this.lastBlocks = newBlocksData;

        // --- 7. 生成 Patch 载荷 ---
        if (oldBlocks.length === 0 || insertedBlocksData.length > 50 || deleteCount > 50) {
            return {
                type: 'full',
                html: newBlocksData.map(b => b.html).join('')
            };
        }

        return {
            type: 'patch',
            start: start,
            deleteCount: deleteCount,
            htmls: insertedBlocksData.map(b => b.html)
        };
    }
}


const renderer = new SmartRenderer();

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('texPreview.start', () => {
            TexPreviewPanel.createOrShow(context.extensionPath);
        })
    );
    let debounceTimer: NodeJS.Timeout | undefined;
    const DEBOUNCE_DELAY = 100;
    vscode.workspace.onDidChangeTextDocument(e => {
        if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
            if (debounceTimer) {clearTimeout(debounceTimer);}
            debounceTimer = setTimeout(() => {
                TexPreviewPanel.currentPanel?.update();
            }, DEBOUNCE_DELAY);
        }
    }, null, context.subscriptions);

    vscode.window.onDidChangeActiveTextEditor(e => {
        TexPreviewPanel.currentPanel?.update();
    }, null, context.subscriptions);
}


class TexPreviewPanel {
    public static currentPanel: TexPreviewPanel | undefined;
    public static readonly viewType = 'texPreview';
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionPath: string;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionPath: string) {
        const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
        if (TexPreviewPanel.currentPanel) {
            TexPreviewPanel.currentPanel._panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            TexPreviewPanel.viewType, 'TeX Preview', column,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.file(extensionPath),
                    vscode.Uri.file(path.join(extensionPath, 'node_modules'))
                ]
            }
        );
        TexPreviewPanel.currentPanel = new TexPreviewPanel(panel, extensionPath);
    }

    // 在 TexPreviewPanel.createOrShow 逻辑中
    private constructor(panel: vscode.WebviewPanel, extensionPath: string) {
        this._panel = panel;
        this._extensionPath = extensionPath;

        // 关键：每次打开新窗口都重置渲染器状态
        renderer.resetState();

        this._panel.webview.html = this._getWebviewSkeleton();
        this.update();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose() {
        TexPreviewPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }

    public update() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {return;}
        const text = editor.document.getText();
        const payload = renderer.render(text);
        this._panel.webview.postMessage({ command: 'update', payload: payload });
    }

    private getKatexPaths() {
        let katexMainPath = "";
        try {
            katexMainPath = require.resolve('katex');
        } catch (e) {
            try {
                const pkgPath = require.resolve('@iktakahiro/markdown-it-katex/package.json');
                const pkgDir = path.dirname(pkgPath);
                katexMainPath = path.join(pkgDir, 'node_modules', 'katex', 'dist', 'katex.min.css');
            } catch (e2) {
                katexMainPath = path.join(this._extensionPath, 'node_modules', '@iktakahiro', 'markdown-it-katex', 'node_modules', 'katex', 'dist', 'katex.min.css');
            }
        }
        let distDir = "";
        if (katexMainPath.includes('dist')) {
            distDir = path.dirname(katexMainPath);
        } else {
             distDir = path.join(path.dirname(katexMainPath), 'dist');
        }
        return {
            cssFile: vscode.Uri.file(path.join(distDir, 'katex.min.css')),
            distDirUri: this._panel.webview.asWebviewUri(vscode.Uri.file(distDir))
        };
    }

    private _getWebviewSkeleton() {
        const paths = this.getKatexPaths();
        const katexCssUri = this._panel.webview.asWebviewUri(paths.cssFile);
        const stylePath = vscode.Uri.file(path.join(this._extensionPath, 'src/preview-style.css'));
        const styleUri = this._panel.webview.asWebviewUri(stylePath);
        const baseUri = paths.distDirUri + '/';

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <base href="${baseUri}">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this._panel.webview.cspSource} 'unsafe-inline'; font-src ${this._panel.webview.cspSource} data:; script-src ${this._panel.webview.cspSource} 'unsafe-inline' https://unpkg.com;">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>TeX Preview</title>
                <link rel="stylesheet" href="${katexCssUri}">
                <link rel="stylesheet" href="${styleUri}">
            </head>
            <body>
                <div id="content-root"></div>
                <script>
                    const contentRoot = document.getElementById('content-root');

                    // --- 智能字体防抖系统 (Auto-Debounce) ---
                    (function() {
                        try {
                            const root = document.documentElement;
                            // 1. 读取 CSS 中定义的原始值 (例如 "2.2vw" 或 "18px")
                            const computedStyle = getComputedStyle(root);
                            const rawValue = computedStyle.getPropertyValue('--base-font-size').trim();

                            if (!rawValue) return; // 没定义变量，跳过

                            // 2. 检查是否是视口单位 (vw 或 vh)
                            // 正则匹配：数字 + vw/vh，例如 "2.2vw", "1.5vh"
                            const match = rawValue.match(/^([\\d.]+)(vw|vh)$/);

                            if (match) {
                                // === 命中动态单位，启用 JS 防抖接管 ===
                                console.log('[TeX Preview] Detected viewport unit:', rawValue, '-> Enabling debounce mode.');

                                const value = parseFloat(match[1]); // e.g. 2.2
                                const unit = match[2];              // e.g. 'vw'
                                const ratio = value / 100;          // e.g. 0.022

                                let resizeTimer;

                                function updateFixedSize() {
                                    // 获取当前视口尺寸
                                    const viewportSize = unit === 'vw'
                                        ? window.innerWidth
                                        : window.innerHeight;

                                    // 计算绝对像素值
                                    let newPx = viewportSize * ratio;

                                    // 可选：设置安全范围 (防止变得太小看不见)
                                    if (newPx < 12) newPx = 12;

                                    // 【关键】直接覆盖 CSS 变量为固定的 px
                                    // 这样在拖动过程中，浏览器认为它是固定值，不会触发重排
                                    root.style.setProperty('--base-font-size', newPx + 'px');
                                }

                                // 立即执行一次，将 vw 转换为 px
                                updateFixedSize();

                                // 添加防抖监听
                                window.addEventListener('resize', () => {
                                    if (resizeTimer) clearTimeout(resizeTimer);
                                    // 100ms 后再更新字体，拖动期间保持原字体大小不变
                                    resizeTimer = setTimeout(updateFixedSize, 200);
                                });

                            } else {
                                // === 命中固定单位 (px, em, rem等) ===
                                console.log('[TeX Preview] Detected fixed unit:', rawValue, '-> Using Native CSS.');
                                // 什么都不做，让 CSS 原生工作，这是性能最好的
                            }
                        } catch (e) {
                            console.error('Font size auto-setup failed:', e);
                        }
                    })();
                    // -------------------------------------------

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.command === 'update') {
                            const payload = message.payload;
                            if (payload.type === 'full') {
                                contentRoot.innerHTML = payload.html;
                            } else if (payload.type === 'patch') {
                                const { start, deleteCount, htmls = [] } = payload;

                                // --- 核心修复：提前锁定参考节点 (Reference Node) ---
                                // 找到删除范围之后的第一个节点。如果它不存在，说明是在末尾追加，referenceNode 为 null
                                const targetIndex = start + deleteCount;
                                const referenceNode = contentRoot.children[targetIndex] || null;

                                // 执行物理删除
                                for (let i = 0; i < deleteCount; i++) {
                                    if (contentRoot.children[start]) {
                                        contentRoot.removeChild(contentRoot.children[start]);
                                    }
                                }

                                // 执行物理插入
                                if (htmls.length > 0) {
                                    const fragment = document.createDocumentFragment();
                                    const tempDiv = document.createElement('div');
                                    htmls.forEach(html => {
                                        tempDiv.innerHTML = html;
                                        const node = tempDiv.firstElementChild;
                                        if (node) fragment.appendChild(node);
                                    });

                                    // 将新内容精准插入到之前锁定的锚点之前
                                    contentRoot.insertBefore(fragment, referenceNode);
                                }
                            }
                        }
                    });

                    document.addEventListener('click', e => {
                        const target = e.target.closest('a');
                        // 只处理内部跳转链接
                        if (target && target.getAttribute('href') && target.getAttribute('href').startsWith('#')) {
                            const id = target.getAttribute('href').substring(1);
                            const element = document.getElementById(id);

                            if (element) {
                                e.preventDefault();

                                // 找到包含该锚点的最外层 latex-block
                                const parentBlock = element.closest('.latex-block');
                                const scrollTarget = parentBlock || element;

                                // 执行平滑滚动
                                scrollTarget.scrollIntoView({
                                    behavior: 'smooth',
                                    block: 'center'
                                });

                                // 高亮特效：闪烁 3 次
                                if (parentBlock) {
                                    parentBlock.classList.add('jump-highlight');
                                    setTimeout(() => {
                                        parentBlock.classList.remove('jump-highlight');
                                    }, 2000);
                                }
                            }
                        }
                    });
                </script>
            </body>
            </html>`;
    }
}
export function deactivate() {}