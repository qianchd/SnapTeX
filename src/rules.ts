import { toRoman, capitalizeFirstLetter, applyStyleToTexList, extractAndHideLabels, cleanLatexCommands, findBalancedClosingBrace } from './utils';
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

    // --- [New] Step 0.5: Handle LaTeX special spaces (~) ---
    // Fix: Prevent ~~~~~~ from being parsed as Markdown strikethrough (~~).
    // Convert ~ to non-breaking space (&nbsp;) and protect it.
    {
        name: 'latex_special_spaces',
        priority: 15,
        apply: (text, renderer) => {
            // Global replace tilde with protected non-breaking space
            return text.replace(/~/g, () => renderer.pushInlineProtected('&nbsp;'));
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
        priority: 33,
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

    // --- Step 3: Algorithm (Priority 35) ---
    {
        name: 'algorithm',
        priority: 35,
        apply: (text: string, renderer: any) => {
            return text.replace(/\\begin\{algorithm\}(?:\[.*?\])?([\s\S]*?)\\end\{algorithm\}/gi, (match, content) => {
                const captionMatch = content.match(/\\caption\{([^}]+)\}/);
                let captionText = captionMatch ? captionMatch[1] : '';
                const captionHtml = captionText ?
                    `<div class="alg-caption">Algorithm: ${renderer.renderInline(captionText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => `$${c.trim()}$`))}</div>` : '';

                const algRegex = /\\begin\{algorithmic\}(?:\[(.*?)\])?([\s\S]*?)\\end\{algorithmic\}/g;
                let bodyHtml = '';
                let matchAlg;

                while ((matchAlg = algRegex.exec(content)) !== null) {
                    const params = matchAlg[1] || '';
                    const rawBody = matchAlg[2];
                    const showNumbers = params.includes('1');
                    const listTag = showNumbers ? 'ol' : 'ul';

                    const lines = rawBody.split('\n');
                    let listItems = '';

                    lines.forEach(line => {
                        let trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith('%')) {return;}
                        if (trimmed.startsWith('\\renewcommand') || trimmed.startsWith('\\setlength')) {return;}

                        let prefixHtml = "";
                        let contentToRender = trimmed;
                        let isSpecialLine = false;

                        if (trimmed.match(/^\\(Require|Ensure|Input|Output)/)) {
                             const isInput = trimmed.match(/^\\(Require|Input)/);
                             const label = isInput ? 'Input:' : 'Output:';
                             prefixHtml = `<strong>${label}</strong> `;
                             contentToRender = trimmed.replace(/^\\(Require|Ensure|Input|Output)\s*/, '');
                             isSpecialLine = true;
                        }
                        else if (trimmed.match(/^\\State/)) {
                             contentToRender = trimmed.replace(/^\\State\s*/, '');
                             if (contentToRender.startsWith('{') && contentToRender.endsWith('}')) {
                                 contentToRender = contentToRender.substring(1, contentToRender.length - 1);
                             }
                        }

                        // --- 1. Robust Color Handling using utils.ts ---
                        // Replaces {\color{name} ...} correctly, even with nested braces like 10^{-2}
                        let colorProcessed = "";
                        let lastIndex = 0;
                        const colorRegex = /\{\\color\{([a-zA-Z0-9]+)\}/g;
                        let colorMatch;

                        while ((colorMatch = colorRegex.exec(contentToRender)) !== null) {
                            // match[0] is "{\color{red}"
                            const colorName = colorMatch[1];
                            const startIndex = colorMatch.index;

                            // Find the closing brace for the opening '{' at startIndex
                            const closingIndex = findBalancedClosingBrace(contentToRender, startIndex);

                            if (closingIndex !== -1) {
                                // Add text before the color block
                                colorProcessed += contentToRender.substring(lastIndex, startIndex);

                                // Extract inner content: from end of "{\color{name}" to the closing brace
                                const headerLength = colorMatch[0].length; // length of "{\color{red}" NOT including content
                                // Wait, match[0] is "{\color{red}".
                                // The content starts AFTER match[0].
                                // But match[0] has TWO open braces: '{' and the one in '\color{'.
                                // Actually regex "{\\color{name}" matches literally.
                                // Let's verify brace depth of the header:
                                // "{" (+1) "\color" "{" (+2) "name" "}" (+1).
                                // So at the end of the regex match, we are at depth 1.
                                // The findBalancedClosingBrace started at 0, counts the first {, goes to end.
                                // So it returns the index of the final closing brace.

                                // Content is between header end and closingIndex
                                const innerContent = contentToRender.substring(startIndex + headerLength, closingIndex);
                                colorProcessed += `<span style="color:${colorName}">${innerContent}</span>`;

                                lastIndex = closingIndex + 1;
                                colorRegex.lastIndex = lastIndex;
                            } else {
                                // Fallback for unbalanced
                                colorProcessed += colorMatch[0];
                                lastIndex = startIndex + colorMatch[0].length;
                            }
                        }
                        colorProcessed += contentToRender.substring(lastIndex);
                        contentToRender = colorProcessed;

                        // Also support \color{red}{text} style (standard command style) if needed
                        contentToRender = contentToRender.replace(/\\color\{([a-zA-Z]+)\}\{([^}]*)\}/g, '<span style="color:$1">$2</span>');

                        // --- 2. Other Formatting ---
                        contentToRender = contentToRender.replace(/\\textbf\{((?:[^{}]|{[^{}]*})*)\}/g, '**$1**');
                        contentToRender = contentToRender.replace(/\\textit\{((?:[^{}]|{[^{}]*})*)\}/g, '*$1*');
                        contentToRender = contentToRender.replace(/\\eqref\{([^}]+)\}/g, '(<span class="latex-ref">$1</span>)');
                        contentToRender = contentToRender.replace(/\\ref\{([^}]+)\}/g, '<span class="latex-ref">$1</span>');
                        contentToRender = contentToRender.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => `$${c.trim()}$`);

                        // --- 3. Render Inline ---
                        const renderedContent = renderer.renderInline(contentToRender);

                        const itemClass = isSpecialLine ? "alg-item alg-item-no-marker" : "alg-item";
                        listItems += `<li class="${itemClass}">${prefixHtml}${renderedContent}</li>`;
                    });

                    bodyHtml += `<${listTag} class="alg-list">${listItems}</${listTag}>`;
                }

                return `\n\n<div class="latex-block algorithm">
                            ${captionHtml}
                            ${bodyHtml}
                            <div class="alg-bottom-rule"></div>
                        </div>\n\n`;
            });
        }
    },

    // --- Step 10: Table (Basic tabular parsing) ---
    // Enhanced to handle \makecell, threeparttable, tablenotes, and tabular*
    {
        name: 'table',
        priority: 36,
        apply: (text: string, renderer: any) => {
            return text.replace(/\\begin\{table\}(?:\[.*?\])?([\s\S]*?)\\end\{table\}/gi, (match, content) => {
                // 1. Extract and Render Caption
                const captionMatch = content.match(/\\caption\{([^}]+)\}/);
                const captionText = captionMatch ? captionMatch[1] : '';
                const captionHtml = captionText ?
                    `<div class="table-caption"><strong>Table:</strong> ${renderer.renderInline(captionText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => `$${c.trim()}$`))}</div>` : '';

                // 2. Pre-clean environment wrappers (threeparttable etc.)
                let innerContent = content.replace(/\\begin\{threeparttable\}/g, '').replace(/\\end\{threeparttable\}/g, '');

                // 3. Extract tablenotes
                let notesHtml = '';
                const notesMatch = innerContent.match(/\\begin\{tablenotes\}(?:\[.*?\])?([\s\S]*?)\\end\{tablenotes\}/);
                if (notesMatch) {
                    const notesBody = notesMatch[1];
                    innerContent = innerContent.replace(notesMatch[0], '');
                    const noteItems = notesBody.split('\\item')
                        .filter((i: string) => i.trim().length > 0)
                        .map((item: string) => {
                            const lblMatch = item.match(/^\[(.*?)\]/);
                            let labelHtml = '';
                            let itemText = item;
                            if (lblMatch) {
                                labelHtml = `<strong>${renderer.renderInline(lblMatch[1])}</strong> `;
                                itemText = item.substring(lblMatch[0].length);
                                itemText = itemText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => `$${c.trim()}$`);
                            }
                            return `<li class="note-item">${labelHtml}${renderer.renderInline(itemText.trim())}</li>`;
                        }).join('');
                    notesHtml = `<div class="latex-tablenotes"><ul>${noteItems}</ul></div>`;
                }

                // 4. Handle \makecell (Pre-process)
                const makecellRegex = /\\makecell(?:\[.*?\])?\{/g;
                let mcMatch;
                let processedContent = "";
                let lastIndex = 0;
                while ((mcMatch = makecellRegex.exec(innerContent)) !== null) {
                    const startIndex = mcMatch.index;
                    processedContent += innerContent.substring(lastIndex, startIndex);
                    const openBraceIndex = startIndex + mcMatch[0].length - 1;
                    const closingIndex = findBalancedClosingBrace(innerContent, openBraceIndex);
                    if (closingIndex !== -1) {
                        let cellInner = innerContent.substring(openBraceIndex + 1, closingIndex);
                        cellInner = cellInner.replace(/\\\\/g, '<br/>');
                        processedContent += `<div class="makecell">${cellInner}</div>`;
                        lastIndex = closingIndex + 1;
                    } else {
                        processedContent += mcMatch[0];
                        lastIndex = startIndex + mcMatch[0].length;
                    }
                }
                processedContent += innerContent.substring(lastIndex);
                innerContent = processedContent;

                // 5. Extract Tabular Content
                const tabularMatch = innerContent.match(/\\begin\{tabular\*?\}(?:\{[^}]+\})*(?:\{[^}]+\})?([\s\S]*?)\\end\{tabular\*?\}/);

                let tableHtml = '';
                if (tabularMatch) {
                    let rawContent = tabularMatch[1];

                    // --- [Updated] Cleaning Logic for Layout/Booktabs ---
                    // Remove \toprule, \midrule, \bottomrule, \hline
                    rawContent = rawContent.replace(/\\(toprule|midrule|bottomrule|hline|centering|raggedright|raggedleft)/g, '');
                    // Remove \cmidrule{2-3} or \cmidrule(lr){2-3}
                    rawContent = rawContent.replace(/\\cmidrule(?:\[.*?\])?(?:\(.*?\))?\{[^}]+\}/g, '');
                    // Remove \cline{2-3}
                    rawContent = rawContent.replace(/\\cline\{[^}]+\}/g, '');
                    // Remove \vspace{2pt} or \vspace*{2pt}
                    rawContent = rawContent.replace(/\\vspace\*?\{[^}]+\}/g, '');
                    // Remove \setlength...
                    rawContent = rawContent.replace(/\\setlength\\[a-zA-Z]+\{[^}]+\}/g, '');
                    // Remove comment chars at end of lines inside tabular content to prevent parsing issues
                    rawContent = rawContent.replace(/%.*$/gm, '');

                    const rows = rawContent.split(/\\\\(?:\[.*?\])?/)
                        .filter((r: string) => r.trim().length > 0)
                        .map((rowText: string) => {
                            const cells = rowText.split('&').map((c: string) => {
                                let cellContent = c.trim();
                                let cellAttrs = 'style="padding: 5px 10px; border: 1px solid #ddd;"';

                                // Handle \multicolumn
                                const multiColMatch = cellContent.match(/^\\multicolumn\{(\d+)\}\{[^}]+\}\{(.*)\}$/);
                                if (multiColMatch) {
                                    const colspan = multiColMatch[1];
                                    let inner = multiColMatch[2];
                                    if (inner.endsWith('}')) { inner = inner.slice(0, -1); }

                                    const startContentIdx = cellContent.indexOf('}{', cellContent.indexOf('}{') + 1) + 2;
                                    if (startContentIdx > 2) {
                                        const endIdx = findBalancedClosingBrace(cellContent, startContentIdx - 1);
                                        if (endIdx !== -1) { inner = cellContent.substring(startContentIdx, endIdx); }
                                    }
                                    cellAttrs += ` colspan="${colspan}" align="center"`;
                                    cellContent = inner;
                                }

                                // Handle \multirow
                                const multiRowMatch = cellContent.match(/^\\multirow\{(\d+)\}\{[^}]+\}\{(.*)\}$/);
                                if (multiRowMatch) {
                                    const startContentIdx = cellContent.indexOf('}{', cellContent.indexOf('}{') + 1) + 2;
                                    if (startContentIdx > 2) {
                                        const endIdx = findBalancedClosingBrace(cellContent, startContentIdx - 1);
                                        if (endIdx !== -1) { cellContent = cellContent.substring(startContentIdx, endIdx); }
                                    }
                                    cellAttrs += ` style="vertical-align: middle;"`;
                                }

                                cellContent = cellContent
                                    .replace(/\\tnote\{([^}]+)\}/g, '<sup>$1</sup>')
                                    .replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => `$${c.trim()}$`);

                                // Render Inline
                                return `<td ${cellAttrs}>${renderer.renderInline(cellContent)}</td>`;
                            });

                            return `<tr>${cells.join('')}</tr>`;
                        }).join('');

                    tableHtml = `<table style="border-collapse: collapse; margin: 0 auto; width: 100%;">${rows}</table>`;
                }

                return `\n\n<div class="latex-block table">
                            ${captionHtml}
                            <div class="table-body">${tableHtml}</div>
                            ${notesHtml}
                        </div>\n\n`;
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
        priority: 31,
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

    // --- Step 13: Text Styles ---
    {
        name: 'text_styles',
        priority: 110,
        apply: (text, renderer) => {
            // 1. 支持 textbf, textit, texttt, textsf, textrm
            text = text.replace(/\\(textbf|textit|texttt|textsf|textrm)\{((?:[^{}]|{[^{}]*})*)\}/g, (match, cmd, content) => {
                let startTag = '', endTag = '';

                switch (cmd) {
                    case 'textbf':
                        startTag = '<strong>'; endTag = '</strong>'; break;
                    case 'textit':
                        startTag = '<em>'; endTag = '</em>'; break;
                    case 'texttt':
                        startTag = '<code>'; endTag = '</code>'; break;
                    case 'textsf':
                        startTag = '<span style="font-family: sans-serif;">'; endTag = '</span>'; break;
                    case 'textrm':
                        startTag = '<span style="font-family: serif;">'; endTag = '</span>'; break;
                }

                return applyStyleToTexList(startTag, endTag, content);
            });

            // 2. 支持老式写法 {\bf ...}, {\it ...}, {\sf ...}, {\rm ...}, {\tt ...}
            text = text.replace(/\{\\(bf|it|sf|rm|tt)\s+((?:[^{}]|{[^{}]*})*)\}/g, (match, cmd, content) => {
                let startTag = '', endTag = '';

                switch (cmd) {
                    case 'bf':
                        startTag = '<strong>'; endTag = '</strong>'; break;
                    case 'it':
                        startTag = '<em>'; endTag = '</em>'; break;
                    case 'tt':
                        startTag = '<code>'; endTag = '</code>'; break;
                    case 'sf':
                        startTag = '<span style="font-family: sans-serif;">'; endTag = '</span>'; break;
                    case 'rm':
                        startTag = '<span style="font-family: serif;">'; endTag = '</span>'; break;
                }

                return applyStyleToTexList(startTag, endTag, content);
            });

            // 3. 支持颜色
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