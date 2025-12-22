import { toRoman, capitalizeFirstLetter, applyStyleToTexList, extractAndHideLabels, cleanLatexCommands } from './utils';
import { PreprocessRule } from './types';

/**
 * Default preprocessing rule set
 * Priority (priority) explanation: The smaller the number, the earlier it is executed.
 * Suggestion: Formula protection (30-40) -> Structure conversion (50-80) -> List/Style (90-110)
 */
export const DEFAULT_PREPROCESS_RULES: PreprocessRule[] = [
    // --- Step 0: Handle escape characters (Highest priority, prevents interference with subsequent regex) ---
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

    // --- Step 1: Roman numerals and special markers ---
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

    // --- Step 2: Block-level math formulas (Enter protected area) ---
    {
        name: 'display_math',
        priority: 30,
        apply: (text, renderer) => {
            const mathBlockRegex = /(\$\$([\s\S]*?)\$\$)|(\\\[([\s\S]*?)\\\])|(\\begin\{(equation|align|gather|multline|flalign|alignat)(\*?)\}([\s\S]*?)\\end\{\6\7\})/gi;
            return text.replace(mathBlockRegex, (match, m1, c1, m3, c4, m5, envName, star, c8, offset, fullString) => {
                let content = c1 || c4 || c8 || match;
                const { cleanContent, hiddenHtml } = extractAndHideLabels(content);
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

    // --- Step 3: Inline formula protection ---
    {
        name: 'inline_math',
        priority: 40,
        apply: (text, renderer) => {
            return text.replace(/(\$((?:\\.|[^\\$])*)\$)/gm, (match) => renderer.pushInlineProtected(match));
        }
    },

    // --- Step 4 & 5: Theorem and proof environments ---
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

    // --- Step 6: Metadata \maketitle and abstract ---
    {
        name: 'maketitle_and_abstract',
        priority: 60,
        apply: (text, renderer) => {
            // 1. Handle \maketitle (Keep previous logic)
            if (text.includes('\\maketitle')) {
                let titleBlock = '';
                if (renderer.currentTitle) {titleBlock += `<h1 class="latex-title">${renderer.currentTitle}</h1>`;}
                if (renderer.currentAuthor) {titleBlock += `<div class="latex-author">${renderer.currentAuthor.replace(/\\\\/g, '<br/>')}</div>`;}
                text = text.replace(/\\maketitle.*/g, `\n\n${titleBlock}\n\n`);
            }

            // 2. Enhanced Abstract recognition
            text = text.replace(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/gi, (match, content) => {
                // Explicitly add newlines to ensure it's not misjudged by MD engine as connected to context
                return `\n\n%%%ABSTRACT_START%%%\n\n${content.trim()}\n\n%%%ABSTRACT_END%%%\n\n`;
            });

            // 3. Compatible with two Keywords syntaxes
            // Syntax A: \begin{keywords} ... \end{keywords}
            // Syntax B: \noindent{\bf Keywords}: ... or Keywords: ...
            const keywordsRegex = /(?:\\begin\{keywords?\}([\s\S]*?)\\end\{keywords?\}|\\noindent\{\\bf Keywords\}:\s*(.*))/gi;

            text = text.replace(keywordsRegex, (match, contentA, contentB) => {
                const content = (contentA || contentB || '').trim();
                return `\n\n%%%KEYWORDS_START%%%${content}%%%KEYWORDS_END%%%\n\n`;
            });

            return text;
        }
    },
    // --- Step 7: Section titles ---
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

    // --- Step 8: Figure (Enhanced with PDF support) ---
    {
        name: 'figure',
        priority: 80,
        apply: (text: string, renderer: any) => {
            return text.replace(/\\begin\{figure\}(?:\[.*?\])?([\s\S]*?)\\end\{figure\}/gi, (match, content) => {
                const captionMatch = content.match(/\\caption\{([^}]+)\}/);
                // Use cleanLatexCommands with renderer to protect inline math in captions
                const caption = captionMatch ?
                    `<div class="figure-caption"><strong>Figure:</strong> ${cleanLatexCommands(captionMatch[1], renderer)}</div>` : '';

                // Extract image path
                const imgMatch = content.match(/\\includegraphics(?:\[.*?\])?\{([^}]+)\}/);
                const imgPath = imgMatch ? imgMatch[1] : '';

                if (imgPath) {
                    // Check file extension for PDF
                    if (imgPath.toLowerCase().endsWith('.pdf')) {
                        // Generate a unique ID for the canvas
                        const canvasId = `pdf-${Math.random().toString(36).substr(2, 9)}`;
                        // IMPORTANT: Use <canvas> for PDF, containing 'data-pdf-src' attribute for panel.ts to detect
                        return `\n\n<div class="latex-block figure">
                                    <canvas id="${canvasId}" data-pdf-src="LOCAL_IMG:${imgPath}" style="width:100%; max-width:100%; display:block; margin:0 auto;"></canvas>
                                    ${caption}
                                </div>\n\n`;
                    } else {
                        // Standard handling for png/jpg using <img>
                        return `\n\n<div class="latex-block figure">
                                    <img src="LOCAL_IMG:${imgPath}" style="max-width:100%; display:block; margin:0 auto;">
                                    ${caption}
                                </div>\n\n`;
                    }
                }
                return `\n\n<div class="latex-block figure">[Image Not Found]${caption}</div>\n\n`;
            });
        }
    },

    // --- Step 9: Algorithm (Structured rendering) ---
    {
        name: 'algorithm',
        priority: 81,
        apply: (text: string, renderer: any) => {
            return text.replace(/\\begin\{algorithm\}(?:\[.*?\])?([\s\S]*?)\\end\{algorithm\}/gi, (match, content) => {
                const captionMatch = content.match(/\\caption\{([^}]+)\}/);
                const caption = captionMatch ?
                    `<div class="alg-caption"><strong>Algorithm:</strong> ${cleanLatexCommands(captionMatch[1], renderer)}</div>` : '';

                const body = content
                    .replace(/\\caption\{[^}]+\}/g, '')
                    .replace(/\\label\{[^}]+\}/g, '')
                    .split('\n')
                    .map((line: string) => {
                        let p = line.trim();
                        if (!p || p.startsWith('%')) return '';
                        // Simple simulation of algorithmic keywords
                        p = p.replace(/^\\State\s*/, '• ')
                             .replace(/^\\Ensure\s*/, '<strong>Ensure:</strong> ')
                             .replace(/^\\Require\s*/, '<strong>Require:</strong> ')
                             .replace(/\\If\{([^}]+)\}/, '<strong>If</strong> $1 <strong>then</strong>')
                             .replace(/\\EndIf/, '<strong>End If</strong>')
                             .replace(/\\For\{([^}]+)\}/, '<strong>For</strong> $1 <strong>do</strong>')
                             .replace(/\\EndFor/, '<strong>End For</strong>')
                             .replace(/\\Return/, '<strong>Return</strong>');
                        return `<div class="alg-line" style="padding-left: 20px;">${cleanLatexCommands(p, renderer)}</div>`;
                    }).join('');

                return `\n\n<div class="latex-block algorithm" style="border-top:2px solid; border-bottom:2px solid; padding:10px 0; margin:1em 0;">${caption}<div class="alg-body">${body}</div></div>\n\n`;
            });
        }
    },

    // --- Step 10: Table (Basic tabular parsing) ---
    {
        name: 'table',
        priority: 82,
        apply: (text: string, renderer: any) => {
            return text.replace(/\\begin\{table\}(?:\[.*?\])?([\s\S]*?)\\end\{table\}/gi, (match, content) => {
                const captionMatch = content.match(/\\caption\{([^}]+)\}/);
                const caption = captionMatch ?
                    `<div class="table-caption"><strong>Table:</strong> ${cleanLatexCommands(captionMatch[1], renderer)}</div>` : '';

                const tabularMatch = content.match(/\\begin\{tabular\}(?:\{[^}]+\})?([\s\S]*?)\\end\{tabular\}/);
                let tableHtml = '';
                if (tabularMatch) {
                    const rows = tabularMatch[1].split('\\\\')
                        .filter((r: string) => r.trim().length > 0)
                        .map((rowText: string) => {
                            if (rowText.trim() === '\\hline') return '<tr style="border-bottom: 1px solid black;"><td colspan="100%"></td></tr>';
                            const cells = rowText.split('&').map((c: string) =>
                                `<td style="padding: 5px 10px; border: 1px solid #ddd;">${cleanLatexCommands(c.trim(), renderer)}</td>`
                            );
                            return `<tr>${cells.join('')}</tr>`;
                        }).join('');
                    tableHtml = `<table style="border-collapse: collapse; margin: 0 auto; width:auto;">${rows}</table>`;
                }
                return `\n\n<div class="latex-block table">${caption}<div class="table-body">${tableHtml}</div></div>\n\n`;
            });
        }
    },

    // --- Step 11: Float placeholders ---
    // {
    //     name: 'floats',
    //     priority: 80,
    //     apply: (text, renderer) => {
    //         return text.replace(/\\begin\{(figure|table|algorithm)(\*?)\}([\s\S]*?)\\end\{\1\2\}/gi, (match, envName, star, content) => {
    //             const safeContent = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    //             return `\n\n<div class="latex-float-placeholder" data-env="${envName}">` +
    //                    `<strong class="float-name">[${envName.toUpperCase()}${star}]</strong>` +
    //                    `<pre class="float-content">${safeContent.trim()}</pre>` +
    //                    `</div>\n`;
    //         });
    //     }
    // },

    // --- Step 12: List processing ---
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

    // --- Step 13: Labels and references ---
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

    // --- Step 14: Text styles ---
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
 * Final HTML structure repair (Post-processing)
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