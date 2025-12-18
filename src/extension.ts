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

// --- 1. 增强版 Preamble 解析器 (支持 macros, title, author) ---
function parsePreamble(preamble: string): PreambleData {
    const cleanText = preamble.replace(/(?<!\\)%.*/gm, '');

    // 提取 Title
    const titleMatch = cleanText.match(/\\title\{((?:[^{}]|{[^{}]*})*)\}/);
    const title = titleMatch ? titleMatch[1].replace(/\\\\/g, '<br/>') : undefined;

    // 提取 Author
    const authorMatch = cleanText.match(/\\author\{((?:[^{}]|{[^{}]*})*)\}/);
    const author = authorMatch ? authorMatch[1].replace(/\\\\/g, '<br/>') : undefined;

    // 提取 Macros
    const macros: Record<string, string> = {};
    const macroRegex = /\\(newcommand|renewcommand|def|gdef|DeclareMathOperator)(\*?)\s*\{?(\\[a-zA-Z0-9]+)\}?(?:\[(\d+)\])?/g;

    let match;
    while ((match = macroRegex.exec(cleanText)) !== null) {
        const cmdType = match[1];
        const star = match[2];
        const cmdName = match[3];
        const matchEndIndex = match.index + match[0].length;

        let openBraces = 0;
        let contentStartIndex = -1;
        let contentEndIndex = -1;
        let foundStart = false;

        for (let i = matchEndIndex; i < cleanText.length; i++) {
            const char = cleanText[i];
            if (char === '{') {
                if (!foundStart) { contentStartIndex = i + 1; foundStart = true; }
                openBraces++;
            } else if (char === '}') {
                openBraces--;
                if (foundStart && openBraces === 0) { contentEndIndex = i; break; }
            }
        }

        if (contentStartIndex !== -1 && contentEndIndex !== -1) {
            const definition = cleanText.substring(contentStartIndex, contentEndIndex).trim();
            if (cmdType === 'DeclareMathOperator') {
                if (star === '*') macros[cmdName] = `\\operatorname*{${definition}}`;
                else macros[cmdName] = `\\operatorname{${definition}}`;
            } else {
                macros[cmdName] = definition;
            }
        }
    }

    return { macros, title, author };
}

// --- 分块器 ---
class LatexBlockSplitter {
    public static split(text: string): string[] {
        const blocks: string[] = [];
        let currentBuffer = "";
        let envStack: string[] = [];
        let braceDepth = 0;

        // --- 增强版正则 ---
        // 1: \begin, 2: name, 3: \end, 4: name, 5: {, 6: }, 7: 双换行, 8: $$ 或 \[ 或 \]
        const regex = /(?:\\\$|\\\{|\\\})|(?:(?<!\\)%.*)|(\\begin\{([^}]+)\})|(\\end\{([^}]+)\})|(\{)|(\})|(\n\s*\n)|(?<!\\)(\$\$|\\\[|\\\])/g;

        let lastIndex = 0;
        let match;

        while ((match = regex.exec(text)) !== null) {
            currentBuffer += text.substring(lastIndex, match.index);
            const fullMatch = match[0];

            const isBegin = match[1];
            const beginName = match[2];
            const isEnd = match[3];
            const endName = match[4];
            const isOpenBrace = match[5];
            const isCloseBrace = match[6];
            const isDoubleNewline = match[7];
            const isMathSymbol = match[8]; // $$ 或 \[ 或 \]

            if (isBegin && beginName) {
                if (beginName === 'proof') {
                    // Proof 环境透明处理，不入栈
                } else {
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
                if (endName !== 'proof') {
                    const idx = envStack.lastIndexOf(endName);
                    if (idx !== -1) { envStack = envStack.slice(0, idx); }
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
                if (fullMatch === '$$') {
                    if (envStack.length > 0 && envStack[envStack.length - 1] === '$$') {
                        envStack.pop(); // 公式结束
                    } else {
                        // 公式开始：如果在外层，切断前文
                        if (envStack.length === 0 && braceDepth === 0) {
                            if (currentBuffer.trim().length > 0) { blocks.push(currentBuffer); currentBuffer = ""; }
                        }
                        envStack.push('$$');
                    }
                } else if (fullMatch === '\\[') {
                    if (envStack.length === 0 && braceDepth === 0) {
                        if (currentBuffer.trim().length > 0) { blocks.push(currentBuffer); currentBuffer = ""; }
                    }
                    envStack.push('\\]');
                } else if (fullMatch === '\\]') {
                    if (envStack.length > 0 && envStack[envStack.length - 1] === '\\]') {
                        envStack.pop();
                    }
                }
                currentBuffer += fullMatch;
            } else {
                // 命中转义字符或注释，直接记录
                currentBuffer += fullMatch;
            }
            lastIndex = regex.lastIndex;
        }

        currentBuffer += text.substring(lastIndex);
        if (currentBuffer.trim().length > 0) { blocks.push(currentBuffer); }
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


        // =========================================================
        // 【核心优化】统一保护机制 (Unified Protection Registry)
        // 用于存储所有不能被后续正则误伤的内容：
        // 1. 转义字符 (会被转为 HTML 实体存储)
        // 2. 数学公式 (会被原样存储)
        // =========================================================
        const protectedBlocks: string[] = [];

        // 辅助函数：存入保护区并返回占位符
        // 1. 用于行内元素（不加换行）
        const pushInlineProtected = (content: string) => {
            protectedBlocks.push(content);
            return `%%%PROTECTED_BLOCK_${protectedBlocks.length - 1}%%%`;
        };

        // --- Step 0: 处理转义符 (使用 Inline 保护) ---
        // 必须最先执行，防止 \$ 被识别为公式的 $
        text = text.replace(/\\([$%#&])/g, (match, char) => {
            let res = char;
            if (char === '$') res = '&#36;';
            else if (char === '#') res = '&#35;';
            else if (char === '&') res = '&amp;';
            return pushInlineProtected(res);
        });


        text = text.replace(/\\(Rmnum|rmnum|romannumeral)\s*\{?(\d+)\}?/g, (match, cmd, numStr) => {
            const num = parseInt(numStr);
            // 只有 \Rmnum 需要大写，其余 (\rmnum, \romannumeral) 均为小写
            const isUppercase = cmd === 'Rmnum';
            return this.toRoman(num, isUppercase);
        });


        // 2. 用于块级元素（强制换行隔离）
        const pushDisplayProtected = (content: string) => {
            protectedBlocks.push(content);
            return `\n\n%%%PROTECTED_BLOCK_${protectedBlocks.length - 1}%%%\n\n`;
        };

        // -- Step -1: 处理 \noindent 标识
        text = text.replace(/\\noindent\s*/g, () => {
            return pushInlineProtected('<span class="no-indent-marker"></span>');
        });

        // --- Step 2: 处理 Theorem 等环境 (提前处理) ---
        const thmEnvs = ['theorem', 'lemma', 'proposition', 'condition', 'assumption', 'remark', 'definition', 'corollary', 'example'].join('|');
        const thmRegex = new RegExp(`\\\\begin\\{(${thmEnvs})\\}(?:\\[(.*?)\\])?([\\s\\S]*?)\\\\end\\{\\1\\}`, 'gi');

        let hasMatch = true; let loopCount = 0;
        while (hasMatch && loopCount < 10) {
            hasMatch = false;
            text = text.replace(thmRegex, (match, envName, optArg, content) => {
                hasMatch = true;
                const DisplayName = this.capitalizeFirstLetter(envName);

                // 将标题部分包裹在 span.latex-thm-head 中
                // 使用 &nbsp; 代替空格，防止在 "Theorem" 和 "1" 之间换行
                let header = `\n\n<span class="latex-thm-head"><strong class="latex-theorem-header">${DisplayName}</strong>`;
                if (optArg) {
                    // 如果有可选参数，如 (Uniform Stability)，也包裹在不换行范围内
                    header += `&nbsp;(${optArg})`;
                }
                header += `.</span>&nbsp; `; // 标题结束后的第一个空格也建议用不换行空格

                return `${header}${content.trim()}\n\n`;
            });
            loopCount++;
        }

        // 处理 \begin{proof} -> **Proof.**
        text = text.replace(/\\begin\{proof\}(?:\[(.*?)\])?/gi, (match, optArg) => {
            const title = optArg ? `Proof (${optArg}).` : `Proof.`;
            // 使用 no-indent-marker 确保 Proof 这一行不缩进（符合习惯）
            return `\n\n<span class="no-indent-marker"></span>**${title}** `;
        });

        // 处理 \end{proof} -> QED 符号
        text = text.replace(/\\end\{proof\}/gi, () => {
            // 使用 float:right 使其对齐到行尾
            return ` <span style="float:right;">QED</span>\n\n`;
        });

        // =========================================================
        // 下面的步骤处理纯文本结构 (Sections, Lists, Styles, etc.)
        // 此时公式和转义符都已经变成了 %%%PROTECTED_BLOCK_N%%%
        // =========================================================

        // 2. Title/Author
        if (text.includes('\\maketitle')) {
            let titleBlock = '';
            if (this.currentTitle) titleBlock += `<h1 class="latex-title">${this.currentTitle}</h1>`;
            if (this.currentAuthor) titleBlock += `<div class="latex-author">${this.currentAuthor}</div>`;
            text = text.replace(/\\maketitle/g, titleBlock);
        }

        // 3. Abstract
        text = text.replace(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/gi, (match, content) => {
            hasSpecialBlocks = true;
            return `\n\n%%%ABSTRACT_START%%%\n\n${content.trim()}\n\n%%%ABSTRACT_END%%%\n\n`;
        });

        // 4. Keywords
        text = text.replace(/\\begin\{keywords?\}([\s\S]*?)\\end\{keywords?\}/gi, (match, content) => {
            hasSpecialBlocks = true;
            const safeContent = content.replace(/\\sep/g, ', ');
            return `\n\n%%%KEYWORDS_START%%%${safeContent.trim()}%%%KEYWORDS_END%%%\n\n`;
        });

        // 5. 处理 Section/Subsection/Subsubsection (合并为一次扫描)
        // Group 1: 捕获级别 (section/subsection/subsubsection)
        // Group 2: 捕获星号 (可选)
        // Group 3: 捕获内容 (支持一层嵌套花括号)
        const sectionRegex = /\\(section|subsection|subsubsection)(\*?)\{((?:[^{}]|{[^{}]*})*)\}\s*(\\label\{[^}]+\})?\s*/g;

        text = text.replace(sectionRegex, (match, level, star, content, label) => {
            const prefix = level === 'section' ? '##' : (level === 'subsection' ? '###' : '####');

            // 如果后面有 label，把它也处理了
            let anchor = "";
            if (label) {
                const labelName = label.match(/\{([^}]+)\}/)?.[1] || "";
                anchor = `<span id="${labelName}" class="latex-label-anchor"></span>`;
            }

            // 只返回一个换行。Markdown 会把紧跟的文字解析为同一块内容，但 h 标签会自动结束。
            return `\n${prefix} ${content.trim()} ${anchor}\n`;
        });

// --- Step 2: 块级公式归一化 (注入行后不缩进标记) ---
        const mathBlockRegex = /(\$\$([\s\S]*?)\$\$)|(\\\[([\s\S]*?)\\\])|(\\begin\{(equation|align|gather|multline|flalign|alignat)(\*?)\}([\s\S]*?)\\end\{\6\7\})/gi;
        text = text.replace(mathBlockRegex, (match, m1, c1, m3, c4, m5, envName, star, c8, offset, fullString) => {
            let content = c1 || c4 || c8;
            if (!content) return match;
            const { cleanContent, hiddenHtml } = this.extractAndHideLabels(content);
            let finalContent = cleanContent.trim();
            if (envName) {
                const name = envName.toLowerCase();
                if (['align', 'flalign', 'alignat', 'multline'].includes(name)) {
                    finalContent = `\\begin{aligned}\n${finalContent}\n\\end{aligned}`;
                } else if (name === 'gather') {
                    finalContent = `\\begin{gathered}\n${finalContent}\n\\end{gathered}`;
                }
            }

            // 检查公式后是否紧跟文字（非空行续接）
            // 2. 处理块级公式后的自动不缩进
            const afterMatch = fullString.substring(offset + match.length);
            const isFollowedByText = /^\s*\S/.test(afterMatch) && !/^\s*\n\n/.test(afterMatch);
            const protectedTag = pushDisplayProtected(`$$\n${finalContent}\n$$\n${hiddenHtml}`);
            return isFollowedByText ? `${protectedTag}<span class="no-indent-marker"></span>` : protectedTag;
        });

        // --- Step 3: 行内公式 ---
        text = text.replace(/(\$((?:\\.|[^\\$])*)\$)/gm, (match) => {
            return pushInlineProtected(match);
        });

        // 7. Float
        text = text.replace(/\\begin\{(figure|table|algorithm)(\*?)\}([\s\S]*?)\\end\{\1\2\}/gi, (match, envName, star, content) => {
             const safeContent = content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
             return `<div class="latex-float-placeholder"><strong>[${envName}${star}]</strong> (Float rendering not implemented)\n${safeContent.trim()}</div>`;
        });

        // 8. List Processing (Itemize/Enumerate)
        const listStack: string[] = [];
        const listRegex = /(\\begin\{(?:itemize|enumerate)\})|(\\end\{(?:itemize|enumerate)\})|(\\item(?:\[(.*?)\])?)/g;
        text = text.replace(listRegex, (match, pBegin, pEnd, pItem, pLabel) => {
            if (pBegin) {
                const type = match.includes('itemize') ? 'ul' : 'ol';
                listStack.push(type);
                return '\n\n';
            } else if (pEnd) {
                listStack.pop();
                return '\n\n';
            } else if (pItem) {
                const depth = listStack.length;
                const indent = '  '.repeat(Math.max(0, depth - 1));
                const currentType = listStack[listStack.length - 1] || 'ul';
                if (pLabel) return `\n${indent}- **${pLabel}** `;
                const bullet = currentType === 'ul' ? '-' : '1.';
                return `\n${indent}${bullet} `;
            }
            return match;
        });

        // 9. Math Environments Standardization (Merged)
        const mathRegex = /(\$\$([\s\S]*?)\$\$)|(\\\[([\s\S]*?)\\\])|(\\begin\{(equation|align|gather|multline|flalign|alignat)(\*?)\}([\s\S]*?)\\end\{\6\7\})/gi;
        text = text.replace(mathRegex, (match, m1, c1, m3, c4, m5, envName, star, c8) => {
            let content = c1 || c4 || c8;
            if (!content) return match;
            const { cleanContent, hiddenHtml } = this.extractAndHideLabels(content);
            let finalContent = cleanContent.trim();
            if (envName) {
                const name = envName.toLowerCase();
                if (['align', 'flalign', 'alignat', 'multline'].includes(name)) {
                    finalContent = `\\begin{aligned}\n${finalContent}\n\\end{aligned}`;
                } else if (name === 'gather') {
                    finalContent = `\\begin{gathered}\n${finalContent}\n\\end{gathered}`;
                }
            }
            return `\n$$\n${finalContent}\n$$\n${hiddenHtml}`;
        });

        // 10.1 Labels
        text = text.replace(/\\label\{([^}]+)\}/g, (match, labelName) => {
             const safeLabel = labelName.replace(/"/g, '&quot;');
             // 使用 inline-block 且不设 display:none，确保 scrollIntoView 引擎能抓到它
             return `<span id="${safeLabel}" class="latex-label-anchor" data-label="${safeLabel}" style="position:relative; top:-50px; visibility:hidden;"></span>`;
        });

        // 10. 处理引用 (Ref, Eqref, Cite, Citep, Citet)
        const refRegex = /\\(ref|eqref|cite|citep|citet)\{([^}]+)\}/g;
        text = text.replace(refRegex, (match, type: string, labels: string) => {
            // 将逗号分隔的多个标签拆分为数组
            const labelArray = labels.split(',').map(item => item.trim());

            const htmlLinks = labelArray.map((label: string) => {
                const safeLabel = label.replace(/"/g, '&quot;');
                let displayText = label;

                // 提取冒号后的部分
                if (label.includes(':')) {
                    const parts = label.split(':');
                    displayText = parts[parts.length - 1];
                }

                // 首字母大写 可选
                // if (displayText.length > 0) {
                //    displayText = displayText.charAt(0).toUpperCase() + displayText.slice(1);
                // }

                // 生成链接，注意：这里我们将原始标签作为 href，处理后的文本作为显示
                return `<a href="#${safeLabel}" class="latex-link latex-${type}">${displayText}</a>`;
            });

            const joinedLinks = htmlLinks.join(', ');

            // 根据类型决定是否包裹容器 (用于 CSS 添加括号)
            if (type === 'citep') {
                return `<span class="latex-citep-container">${joinedLinks}</span>`;
            }
            if (type === 'eqref') {
                return `<span class="latex-eqref-container">${joinedLinks}</span>`;
            }
            return joinedLinks;
        });

        // 11. Text Styles (Bold, Italic, Color)
        // 此时文本中只有 %%%PROTECTED_BLOCK_X%%%，正则不会误伤公式和转义符
        // 11.1 命令式: \textbf{...} 或 \textit{...}
        text = text.replace(/\\(textbf|textit)\{((?:[^{}]|{[^{}]*})*)\}/g, (match, cmd, content) => {
            const tag = cmd === 'textbf' ? 'strong' : 'em';
            return this.applyStyleToText(`<${tag}>`, `</${tag}>`, content);
        });

        // 11.2 作用域式: {\bf ...} 或 {\it ...}
        text = text.replace(/\{\\(bf|it)\s+((?:[^{}]|{[^{}]*})*)\}/g, (match, cmd, content) => {
            const tag = cmd === 'bf' ? 'strong' : 'em';
            return this.applyStyleToText(`<${tag}>`, `</${tag}>`, content);
        });

        // 11.3 颜色: {\color{name} ...} (保持独立)
        text = text.replace(/\{\\color\{([a-zA-Z0-9]+)\}\s*((?:[^{}]|{[^{}]*})*)\}/g, (match, color, content) => {
            return this.applyStyleToText(`<span style="color: ${color}">`, '</span>', content);
        });

        // 12. 【核心优化】统一还原 (Unmask All)
        // 无论是转义字符(如 &#36;) 还是数学公式(如 $$x$$)，都在这里一次性还原
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
        // --- 核心修复：抹除所有以注释开头的行 ---
        // ^[ \t]* : 匹配行首的空格或制表符
        // (?<!\\)% : 匹配非转义的百分号
        // .* : 匹配该行剩下的所有内容
        // (\r?\n)? : 匹配随后的换行符（如果有）
        // 'gm' 模式：g 全局匹配，m 将 ^ 和 $ 视为每一行的开头和结尾
        let cleanText = fullText.replace(/^[ \t]*(?<!\\)%.*(\r?\n)?/gm, '');
        cleanText = cleanText.replace(/(?<!\\)%.*/g, '');

        const docStartRegex = /\\begin\{document\}/;
        const match = cleanText.match(docStartRegex);

        let bodyText = cleanText;
        let currentPreamble = "";

        if (match && match.index !== undefined) {
            currentPreamble = cleanText.substring(0, match.index);
            bodyText = cleanText.substring(match.index + match[0].length);
            bodyText = bodyText.replace(/\\end\{document\}/, '');
        }

        if (currentPreamble !== this.lastPreambleHash) {
            const preambleData = parsePreamble(currentPreamble);
            this.currentTitle = preambleData.title;
            this.currentAuthor = preambleData.author;
            this.rebuildMarkdownEngine(preambleData.macros);
            this.lastBlocks = [];
            this.lastPreambleHash = currentPreamble;
        }

        let rawBlocks = LatexBlockSplitter.split(bodyText);

        if (!this.md) this.rebuildMarkdownEngine({});

        const oldBlocks = this.lastBlocks;

        const newBlocksData = rawBlocks.map(blockText => {
            // 1. 统一换行符并彻底修剪两端空白
            const normalizedText = blockText.replace(/\r\n/g, '\n').trim();

            // 2. 如果块为空（由于连续空行导致），跳过
            if (!normalizedText) return null;

            const { processedText, hasSpecialBlocks } = this.preprocessLatexMath(normalizedText);
            const innerHtml = this.md!.render(processedText);

            let finalHtml = innerHtml;
            if (hasSpecialBlocks) {
                finalHtml = this.postProcessHtml(innerHtml);
            }

            const html = `<div class="latex-block">${finalHtml}</div>`;
            return {
                text: normalizedText, // 用于对比的基准文本
                html: html
            };
        }).filter(b => b !== null) as { text: string, html: string }[];

        if (oldBlocks.length === 0) {
            this.lastBlocks = newBlocksData;
            return {
                type: 'full',
                html: newBlocksData.map(b => b.html).join('')
            };
        }

        let startMatchIndex = 0;
        const minLen = Math.min(newBlocksData.length, oldBlocks.length);
        while (startMatchIndex < minLen) {
            if (newBlocksData[startMatchIndex].text !== oldBlocks[startMatchIndex].text) break;
            startMatchIndex++;
        }

        let endMatchCount = 0;
        const oldRemaining = oldBlocks.length - startMatchIndex;
        const newRemaining = newBlocksData.length - startMatchIndex;
        while (endMatchCount < Math.min(oldRemaining, newRemaining)) {
            const oldIndex = oldBlocks.length - 1 - endMatchCount;
            const newIndex = newBlocksData.length - 1 - endMatchCount;
            if (oldBlocks[oldIndex].text !== newBlocksData[newIndex].text) break;
            endMatchCount++;
        }

        const deleteCount = oldBlocks.length - startMatchIndex - endMatchCount;
        const insertBlocks = newBlocksData.slice(startMatchIndex, newBlocksData.length - endMatchCount);
        const insertHtmls = insertBlocks.map(b => b.html);

        const finalBlocks: { text: string, html: string }[] = [];
        for (let i = 0; i < startMatchIndex; i++) finalBlocks.push(oldBlocks[i]);
        for (let i = 0; i < insertBlocks.length; i++) finalBlocks.push(insertBlocks[i]);
        for (let i = 0; i < endMatchCount; i++) finalBlocks.push(oldBlocks[oldBlocks.length - endMatchCount + i]);
        this.lastBlocks = finalBlocks;

        return {
            type: 'patch',
            start: startMatchIndex,
            deleteCount: deleteCount,
            htmls: insertHtmls
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
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                TexPreviewPanel.currentPanel?.update();
            }, DEBOUNCE_DELAY);
        }
    }, null, context.subscriptions);

    vscode.window.onDidChangeActiveTextEditor(e => {
        TexPreviewPanel.currentPanel?.update();
    }, null, context.subscriptions);
}

// --- Webview 面板管理 (移回 getKatexPaths 和 _getWebviewSkeleton) ---
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
        if (!editor) return;
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
                                // 全量更新
                                contentRoot.innerHTML = payload.html;
                            } else if (payload.type === 'patch') {
                                // 局部增量更新 (Splice DOM)
                                const start = payload.start;
                                const deleteCount = payload.deleteCount;
                                const newHtmls = payload.htmls || [];

                                // 1. 获取当前所有的 block 元素
                                const children = Array.from(contentRoot.children);

                                // 2. 删除需要移除的节点
                                for (let i = 0; i < deleteCount; i++) {
                                    if (children[start + i]) {
                                        contentRoot.removeChild(children[start + i]);
                                    }
                                }

                                // 3. 插入新节点
                                // 找到插入点（参考节点）
                                // 如果删除了元素，后续元素索引会前移，所以参考节点就是原来 start + deleteCount 位置的节点
                                // 但因为删除了，现在的 children[start] 其实就是原来的 children[start + deleteCount] (如果存在)
                                // 所以我们重新获取一下当前状态下的参考节点
                                const currentChildren = contentRoot.children;
                                const referenceNode = currentChildren[start] || null;

                                // 创建一个临时容器来把 HTML 字符串转为 DOM 节点
                                const tempDiv = document.createElement('div');

                                newHtmls.forEach(html => {
                                    tempDiv.innerHTML = html;
                                    const newBlock = tempDiv.firstElementChild; // 获取 .latex-block
                                    if (newBlock) {
                                        contentRoot.insertBefore(newBlock, referenceNode);
                                    }
                                });
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