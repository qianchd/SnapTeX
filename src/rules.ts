import { toRoman, capitalizeFirstLetter, applyStyleToTexList } from './utils';
import { PreprocessRule } from './types';

/**
 * 默认预处理规则集
 * 优先级 (priority) 说明：数字越小越先执行。
 * 建议：公式保护 (30-40) -> 结构转换 (50-80) -> 列表/样式 (90-110)
 */
export const DEFAULT_PREPROCESS_RULES: PreprocessRule[] = [
    // --- Step 0: 处理转义符 (优先级最高，防止干扰后续正则) ---
    {
        name: 'escaped_chars',
        priority: 10,
        apply: (text, renderer) => {
            return text.replace(/\\([$%#&])/g, (match, char) => {
                const entities: Record<string, string> = { '$': '&#36;', '#': '&#35;', '&': '&amp;', '%': '&#37;' };
                return renderer.pushInlineProtected(entities[char] || char);
            });
        }
    },

    // --- Step 1: 罗马数字与特殊标记 ---
    {
        name: 'romannumeral',
        priority: 20,
        apply: (text, renderer) => {
            text = text.replace(/\\(Rmnum|rmnum|romannumeral)\s*\{?(\d+)\}?/g, (match, cmd, numStr) => {
                return toRoman(parseInt(numStr), cmd === 'Rmnum');
            });
            return text.replace(/\\noindent\s*/g, () => renderer.pushInlineProtected('<span class="no-indent-marker"></span>'));
        }
    },

    // --- Step 2: 块级数学公式 (进入保护区) ---
    {
        name: 'display_math',
        priority: 30,
        apply: (text, renderer) => {
            const mathBlockRegex = /(\$\$([\s\S]*?)\$\$)|(\\\[([\s\S]*?)\\\])|(\\begin\{(equation|align|gather|multline|flalign|alignat)(\*?)\}([\s\S]*?)\\end\{\6\7\})/gi;
            return text.replace(mathBlockRegex, (match, m1, c1, m3, c4, m5, envName, star, c8, offset, fullString) => {
                let content = c1 || c4 || c8 || match;
                const { cleanContent, hiddenHtml } = renderer.extractAndHideLabels(content);
                let finalMath = cleanContent.trim();

                if (envName) {
                    const name = envName.toLowerCase();
                    if (['align', 'flalign', 'alignat', 'multline'].includes(name)) {
                        finalMath = `\\begin{aligned}\n${finalMath}\n\\end{aligned}`;
                    } else if (name === 'gather') {
                        finalMath = `\\begin{gathered}\n${finalMath}\n\\end{gathered}`;
                    }
                }

                const afterMatch = fullString.substring(offset + match.length);
                const isFollowedByText = /^\s*\S/.test(afterMatch) && !/^\s*\n\n/.test(afterMatch);
                const mathHtml = `$$\n${finalMath}\n$$\n${hiddenHtml}`;
                const protectedTag = renderer.pushDisplayProtected(mathHtml);
                return isFollowedByText ? `${protectedTag}<span class="no-indent-marker"></span>` : protectedTag;
            });
        }
    },

    // --- Step 3: 行内公式保护 ---
    {
        name: 'inline_math',
        priority: 40,
        apply: (text, renderer) => {
            return text.replace(/(\$((?:\\.|[^\\$])*)\$)/gm, (match) => renderer.pushInlineProtected(match));
        }
    },

    // --- Step 4 & 5: 定理与证明环境 ---
    {
        name: 'theorems_and_proofs',
        priority: 50,
        apply: (text, renderer) => {
            const thmEnvs = ['theorem', 'lemma', 'proposition', 'condition', 'assumption', 'remark', 'definition', 'corollary', 'example'].join('|');
            const thmRegex = new RegExp(`\\\\begin\\{(${thmEnvs})\\}(?:\\[(.*?)\\])?([\\s\\S]*?)\\\\end\\{\\1\\}`, 'gi');

            text = text.replace(thmRegex, (match, envName, optArg, content) => {
                const displayName = capitalizeFirstLetter(envName);
                let header = `\n<span class="latex-thm-head"><strong class="latex-theorem-header">${displayName}</strong>`;
                if (optArg) { header += `&nbsp;(${optArg})`; }
                header += `.</span>&nbsp; `;
                return `${header}${content.trim()}\n`;
            });

            text = text.replace(/\\begin\{proof\}(?:\[(.*?)\])?/gi, (match, optArg) => {
                const title = optArg ? `Proof (${optArg}).` : `Proof.`;
                return `\n<span class="no-indent-marker"></span>**${title}** `;
            });
            return text.replace(/\\end\{proof\}/gi, () => ` <span style="float:right;">QED</span>\n`);
        }
    },

    // --- Step 6: 元数据 \maketitle 与摘要 ---
    {
        name: 'maketitle_and_abstract',
        priority: 60,
        apply: (text, renderer) => {
            // 1. 处理 \maketitle (保持之前的逻辑)
            if (text.includes('\\maketitle')) {
                let titleBlock = '';
                if (renderer.currentTitle) titleBlock += `<h1 class="latex-title">${renderer.currentTitle}</h1>`;
                if (renderer.currentAuthor) titleBlock += `<div class="latex-author">${renderer.currentAuthor.replace(/\\\\/g, '<br/>')}</div>`;
                text = text.replace(/\\maketitle.*/g, `\n\n${titleBlock}\n\n`);
            }

            // 2. 增强型 Abstract 识别
            text = text.replace(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/gi, (match, content) => {
                // 明确加上换行，确保不会和上下文连在一起被 MD 引擎误判
                return `\n\n%%%ABSTRACT_START%%%\n\n${content.trim()}\n\n%%%ABSTRACT_END%%%\n\n`;
            });

            // 3. 兼容两种 Keywords 写法
            // 写法 A: \begin{keywords} ... \end{keywords}
            // 写法 B: \noindent{\bf Keywords}: ... 或 Keywords: ...
            const keywordsRegex = /(?:\\begin\{keywords?\}([\s\S]*?)\\end\{keywords?\}|\\noindent\{\\bf Keywords\}:\s*(.*))/gi;

            text = text.replace(keywordsRegex, (match, contentA, contentB) => {
                const content = (contentA || contentB || '').trim();
                return `\n\n%%%KEYWORDS_START%%%${content}%%%KEYWORDS_END%%%\n\n`;
            });

            return text;
        }
    },
    // --- Step 7: 章节标题 ---
    {
        name: 'sections',
        priority: 70,
        apply: (text, renderer) => {
            const sectionRegex = /\\(section|subsection|subsubsection)(\*?)\{((?:[^{}]|{[^{}]*})*)\}\s*(\\label\{[^}]+\})?\s*/g;
            return text.replace(sectionRegex, (match, level, star, content, label) => {
                const prefix = level === 'section' ? '##' : (level === 'subsection' ? '###' : '####');
                let anchor = "";
                if (label) {
                    const labelName = label.match(/\{([^}]+)\}/)?.[1] || "";
                    anchor = `<span id="${labelName}" class="latex-label-anchor"></span>`;
                }
                return `\n${prefix} ${content.trim()} ${anchor}\n`;
            });
        }
    },

    // --- Step 8: 浮动体占位符 ---
    {
        name: 'floats',
        priority: 80,
        apply: (text, renderer) => {
            return text.replace(/\\begin\{(figure|table|algorithm)(\*?)\}([\s\S]*?)\\end\{\1\2\}/gi, (match, envName, star, content) => {
                const safeContent = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                return `\n\n<div class="latex-float-placeholder" data-env="${envName}">` +
                       `<strong class="float-name">[${envName.toUpperCase()}${star}]</strong>` +
                       `<pre class="float-content">${safeContent.trim()}</pre>` +
                       `</div>\n`;
            });
        }
    },

    // --- Step 9: 列表处理 ---
    {
        name: 'lists',
        priority: 90,
        apply: (text, renderer) => {
            const listStack: string[] = [];
            return text.replace(/(\\begin\{(?:itemize|enumerate)\})|(\\end\{(?:itemize|enumerate)\})|(\\item(?:\[(.*?)\])?)/g, (match, pBegin, pEnd, pItem, pLabel) => {
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
                    if (pLabel) { return `\n${indent}- **${pLabel}** `; }
                    return `\n${indent}${currentType === 'ul' ? '-' : '1.'} `;
                }
                return match;
            });
        }
    },

    // --- Step 10: 标签与引用 ---
    {
        name: 'refs_and_labels',
        priority: 100,
        apply: (text, renderer) => {
            text = text.replace(/\\label\{([^}]+)\}/g, (match, labelName) => {
                const safeLabel = labelName.replace(/"/g, '&quot;');
                return `<span id="${safeLabel}" class="latex-label-anchor" data-label="${safeLabel}" style="position:relative; top:-50px; visibility:hidden;"></span>`;
            });

            return text.replace(/\\(ref|eqref|cite|citep|citet)\{([^}]+)\}/g, (match, type, labels) => {
                const labelArray = labels.split(',').map((l: string) => l.trim());
                const htmlLinks = labelArray.map((label: string) => {
                    const safeLabel = label.replace(/"/g, '&quot;');
                    const displayText = label.includes(':') ? (label.split(':').pop() || label) : label;
                    return `<a href="#${safeLabel}" class="latex-link latex-${type}">${displayText}</a>`;
                });
                const joinedLinks = htmlLinks.join(', ');
                if (type === 'citep') { return `<span class="latex-citep-container">${joinedLinks}</span>`; }
                if (type === 'eqref') { return `<span class="latex-eqref-container">${joinedLinks}</span>`; }
                return joinedLinks;
            });
        }
    },

    // --- Step 11: 文本样式 ---
    {
        name: 'text_styles',
        priority: 110,
        apply: (text, renderer) => {
            text = text.replace(/\\(textbf|textit)\{((?:[^{}]|{[^{}]*})*)\}/g, (match, cmd, content) => {
                const tag = cmd === 'textbf' ? 'strong' : 'em';
                return applyStyleToTexList(`<${tag}>`, `</${tag}>`, content);
            });
            text = text.replace(/\{\\(bf|it)\s+((?:[^{}]|{[^{}]*})*)\}/g, (match, cmd, content) => {
                const tag = cmd === 'bf' ? 'strong' : 'em';
                return applyStyleToTexList(`<${tag}>`, `</${tag}>`, content);
            });
            return text.replace(/\{\\color\{([a-zA-Z0-9]+)\}\s*((?:[^{}]|{[^{}]*})*)\}/g, (match, color, content) => {
                return applyStyleToTexList(`<span style="color: ${color}">`, '</span>', content);
            });
        }
    }
];

/**
 * 最后的 HTML 结构修补 (后处理)
 */
export function postProcessHtml(html: string): string {
    html = html.replace(/<p>\s*%%%ABSTRACT_START%%%\s*<\/p>/g, '<div class="latex-abstract"><span class="latex-abstract-title">Abstract</span>');
    html = html.replace(/%%%ABSTRACT_START%%%/g, '<div class="latex-abstract"><span class="latex-abstract-title">Abstract</span>');
    html = html.replace(/<p>\s*%%%ABSTRACT_END%%%\s*<\/p>/g, '</div>');
    html = html.replace(/%%%ABSTRACT_END%%%/g, '</div>');

    const keywordRegex = /<p>\s*%%%KEYWORDS_START%%%([\s\S]*?)%%%KEYWORDS_END%%%\s*<\/p>/g;
    html = html.replace(keywordRegex, (match, content) => {
        return `<div class="latex-keywords"><strong>Keywords:</strong> ${content}</div>`;
    });
    return html;
}