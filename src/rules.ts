import { toRoman, capitalizeFirstLetter, applyStyleToTexList, extractAndHideLabels, cleanLatexCommands, findBalancedClosingBrace, resolveLatexStyles } from './utils';
import { PreprocessRule } from './types';
import { SmartRenderer } from './renderer';

/**
 * Default preprocessing rule set
 * Priority (priority) explanation: The smaller the number, the earlier it is executed.
 * Suggestion: Formula protection (30-40) -> Structure conversion (50-80) -> List/Style (90-110)
 */
export const DEFAULT_PREPROCESS_RULES: PreprocessRule[] = [
    // --- Step 0: Handle escape characters (Highest priority, prevents interference with subsequent regex) ---
    {
        name: 'escaped_char_dollar',
        priority: 10,
        apply: (text, renderer: SmartRenderer) => {
            return text.replace(/\\([$])/g, (match, char) => {
                const entities: Record<string, string> = { '$': '&#36;' };
                // Keep using pushInlineProtected for raw text to avoid Markdown parsing
                return renderer.pushInlineProtected(entities[char] || char);
            });
        }
    },

    // --- Step 1: Roman numerals and special markers ---
    {
        name: 'romannumeral',
        priority: 20,
        apply: (text, renderer: SmartRenderer) => {
            text = text.replace(/\\(Rmnum|rmnum|romannumeral)\s*\{?(\d+)\}?/g, (match, cmd, numStr) => {
                return toRoman(parseInt(numStr), cmd === 'Rmnum');
            });
            return text.replace(/\\noindent\s*/g, () => renderer.pushInlineProtected('<span class="no-indent-marker"></span>'));
        }
    },

        // --- Step 2: Block-level math formulas (Render and Cache) ---
    {
        name: 'display_math',
        priority: 30,
        apply: (text, renderer: SmartRenderer) => {
            const mathBlockRegex = /(\$\$([\s\S]*?)\$\$)|(\\\[([\s\S]*?)\\\])|(\\begin\{(equation|align|gather|multline|flalign|alignat)(\*?)\}([\s\S]*?)\\end\{\6\7\})/gi;
            return text.replace(mathBlockRegex, (match, m1, c1, m3, c4, m5, envName, star, c8, offset, fullString) => {
                let content = c1 || c4 || c8 || match;

                // 1. Extract labels first so we can generate anchors
                const { cleanContent, hiddenHtml } = extractAndHideLabels(content);
                let finalMath = cleanContent.trim();

                // 2. Compatibility: wrap align/gather in aligned/gathered if they were used
                if (envName) {
                    const name = envName.toLowerCase();
                    if (['align', 'flalign', 'alignat', 'multline'].includes(name)) {
                        finalMath = `\\begin{aligned}\n${finalMath}\n\\end{aligned}`;
                    } else if (name === 'gather') {
                        finalMath = `\\begin{gathered}\n${finalMath}\n\\end{gathered}`;
                    }
                }

                // 3. [CHANGED] Render directly using KaTeX and get the protection token
                // This replaces the old method of pushing raw strings
                const protectedTag = renderer.renderAndProtectMath(finalMath, true);

                const afterMatch = fullString.substring(offset + match.length);
                const isFollowedByText = /^\s*\S/.test(afterMatch) && !/^\s*\n\n/.test(afterMatch);

                // 4. Return Token + Label Anchor + (Optional No Indent Marker)
                return `${protectedTag}${hiddenHtml}` + (isFollowedByText ? '<span class="no-indent-marker"></span>' : '');
            });
        }
    },

    // --- Step 6: Inline formula protection (Render and Cache) ---
    // Note: Priority 40 runs AFTER figure/table/algorithm, so it can catch math in their outputs.
    {
        name: 'inline_math',
        priority: 31,
        apply: (text, renderer: SmartRenderer) => {
            return text.replace(/(\$((?:\\.|[^\\$])*)\$)/gm, (match, fullMatch, content) => {
                // [CHANGED] Call renderAndProtectMath with displayMode=false
                return renderer.renderAndProtectMath(content, false);
            });
        }
    },

    {
        name: 'escaped_chars2',
        priority: 32,
        apply: (text, renderer: SmartRenderer) => {
            return text.replace(/\\([%#&])/g, (match, char) => {
                const entities: Record<string, string> = {'#': '&#35;', '&': '&amp;', '%': '&#37;' };
                // Keep using pushInlineProtected for raw text to avoid Markdown parsing
                return renderer.pushInlineProtected(entities[char] || char);
            });
        }
    },

    // --- Step 0.5: Handle LaTeX special spaces (~) ---
    // Fix: Prevent ~~~~~~ from being parsed as Markdown strikethrough (~~).
    // Convert ~ to non-breaking space (&nbsp;) and protect it.
    {
        name: 'latex_special_spaces',
        priority: 33,
        apply: (text, renderer: SmartRenderer) => {
            // Global replace tilde with protected non-breaking space
            return text.replace(/~/g, () => renderer.pushInlineProtected('&nbsp;'));
        }
    },

    // --- Step 3: Figure (Enhanced with PDF support) ---
    // Note: Priority 33 ensures it runs after display_math(30) but before inline_math(40).
    {
        name: 'figure',
        priority: 34,
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

    // --- Step 4: Algorithm (Priority 35) ---
// --- Step 4: Algorithm ---
    {
        name: 'algorithm',
        priority: 35,
        apply: (text: string, renderer: any) => {
            return text.replace(/\\begin\{algorithm\}(?:\[.*?\])?([\s\S]*?)\\end\{algorithm\}/gi, (match, content) => {
                const captionMatch = content.match(/\\caption\{([^}]+)\}/);
                let captionText = captionMatch ? captionMatch[1] : '';
                if (captionText) {
                    captionText = captionText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => renderer.renderAndProtectMath(c.trim(), false));
                }
                const captionHtml = captionText ?
                    `<div class="alg-caption">Algorithm: ${renderer.renderInline(captionText)}</div>` : '';

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

                        // Apply robust styling
                        contentToRender = resolveLatexStyles(contentToRender);

                        contentToRender = contentToRender.replace(/\\eqref\{([^}]+)\}/g, '(<span class="latex-ref">$1</span>)');
                        contentToRender = contentToRender.replace(/\\ref\{([^}]+)\}/g, '<span class="latex-ref">$1</span>');
                        contentToRender = contentToRender.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => renderer.renderAndProtectMath(c.trim(), false));
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

    // --- Step 5: Table (Priority 36) ---
// --- Step 5: Table (Fixed & Robust) ---
    {
        name: 'table',
        priority: 36,
        apply: (text: string, renderer: any) => {
            return text.replace(/\\begin\{table\}(?:\[.*?\])?([\s\S]*?)\\end\{table\}/gi, (match, content) => {
                // 1. Caption
                const captionMatch = content.match(/\\caption\{([^}]+)\}/);
                let captionText = captionMatch ? captionMatch[1] : '';
                if (captionText) {
                    captionText = captionText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => renderer.renderAndProtectMath(c.trim(), false));
                    captionText = resolveLatexStyles(captionText);
                }
                const captionHtml = captionText ?
                    `<div class="table-caption"><strong>Table:</strong> ${renderer.renderInline(captionText)}</div>` : '';

                // 2. Inner content cleaning
                let innerContent = content.replace(/\\begin\{threeparttable\}/g, '').replace(/\\end\{threeparttable\}/g, '');

                // 3. Extract tablenotes
                // Handle optional args like \begin{tablenotes}[flushleft]
                let notesHtml = '';
                const notesRegex = /\\begin\{tablenotes\}(?:\[.*?\])?([\s\S]*?)\\end\{tablenotes\}/;
                const notesMatch = innerContent.match(notesRegex);

                if (notesMatch) {
                    let notesBody = notesMatch[1];
                    innerContent = innerContent.replace(notesMatch[0], '');

                    // Remove font size commands often found at start of notes
                    notesBody = notesBody.replace(/\\(footnotesize|small|scriptsize|tiny)/g, '');

                    const noteItems = notesBody.split('\\item')
                        .slice(1) // Skip everything before the first \item (preamble)
                        .map((item: string) => {
                            let itemText = item;
                            let labelHtml = '';
                            // Handle \item[label]
                            const lblMatch = item.match(/^\s*\[(.*?)\]/);
                            if (lblMatch) {
                                let labelContent = lblMatch[1];
                                labelContent = labelContent.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => renderer.renderAndProtectMath(c.trim(), false));
                                labelContent = resolveLatexStyles(labelContent);
                                // Ensure label is bold/styled if needed
                                labelHtml = `<strong>${renderer.renderInline(labelContent)}</strong> `;
                                itemText = item.substring(lblMatch[0].length);
                            }
                            itemText = itemText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => renderer.renderAndProtectMath(c.trim(), false));
                            itemText = resolveLatexStyles(itemText);
                            return `<li class="note-item" style="list-style:none">${labelHtml}${renderer.renderInline(itemText.trim())}</li>`;
                        }).join('');
                    notesHtml = `<div class="latex-tablenotes"><ul>${noteItems}</ul></div>`;
                }

                // 4. Handle \makecell
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
                        cellInner = cellInner.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => renderer.renderAndProtectMath(c.trim(), false));
                        cellInner = resolveLatexStyles(cellInner);
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
                let tableHtml = '';
                const beginRegex = /\\begin\{tabular(\*?)\}/g;
                const beginMatch = beginRegex.exec(innerContent);

                if (beginMatch) {
                    const isStar = beginMatch[1] === '*';
                    let contentStartIndex = beginMatch.index + beginMatch[0].length;

                    // Robust Argument Skipping using findBalancedClosingBrace
                    const requiredArgs = isStar ? 2 : 1;
                    let argsFound = 0;

                    while (argsFound < requiredArgs) {
                        while(contentStartIndex < innerContent.length && /\s/.test(innerContent[contentStartIndex])) {contentStartIndex++;}
                        if (contentStartIndex >= innerContent.length) {break;}

                        if (innerContent[contentStartIndex] === '[') {
                            const closeBracket = innerContent.indexOf(']', contentStartIndex);
                            if (closeBracket !== -1) {
                                contentStartIndex = closeBracket + 1;
                                continue;
                            }
                        }

                        if (innerContent[contentStartIndex] === '{') {
                            const closeBrace = findBalancedClosingBrace(innerContent, contentStartIndex);
                            if (closeBrace !== -1) {
                                contentStartIndex = closeBrace + 1;
                                argsFound++;
                            } else { break; }
                        } else { break; }
                    }

                    const endRegex = /\\end\{tabular\*?\}/g;
                    endRegex.lastIndex = contentStartIndex;
                    const endMatch = endRegex.exec(innerContent);

                    if (endMatch) {
                        let rawContent = innerContent.substring(contentStartIndex, endMatch.index);

                        // Protect Math BEFORE splitting
                        rawContent = rawContent.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => renderer.renderAndProtectMath(c.trim(), false));

                        // Remove common table commands
                        rawContent = rawContent.replace(/\\(toprule|midrule|bottomrule|hline|centering|raggedright|raggedleft)/g, '');
                        rawContent = rawContent.replace(/\\cmidrule(?:\[.*?\])?(?:\(.*?\))?\{[^}]+\}/g, '');
                        rawContent = rawContent.replace(/\\cline\{[^}]+\}/g, '');
                        rawContent = rawContent.replace(/\\vspace\*?\{[^}]+\}/g, '');
                        rawContent = rawContent.replace(/\\setlength\\[a-zA-Z]+\{[^}]+\}/g, '');
                        rawContent = rawContent.replace(/%.*$/gm, '');

                        const rows = rawContent.split(/\\\\(?:\[.*?\])?/)
                            .filter((r: string) => r.trim().length > 0)
                            .map((rowText: string) => {
                                const cells = rowText.split('&').map((c: string) => {
                                    let cellContent = c.trim();
                                    let cellAttrs = 'style="padding: 5px 10px; border: 1px solid #ddd;"';

                                    // Handle \multicolumn - Robust manual parsing
                                    if (cellContent.startsWith('\\multicolumn')) {
                                        let currIdx = cellContent.indexOf('{');
                                        if (currIdx !== -1) {
                                            // Arg 1: Colspan
                                            let endIdx = findBalancedClosingBrace(cellContent, currIdx);
                                            if (endIdx !== -1) {
                                                const colspan = cellContent.substring(currIdx + 1, endIdx);

                                                // Arg 2: Align
                                                currIdx = cellContent.indexOf('{', endIdx);
                                                if (currIdx !== -1) {
                                                    endIdx = findBalancedClosingBrace(cellContent, currIdx);
                                                    if (endIdx !== -1) {
                                                        const alignSpec = cellContent.substring(currIdx + 1, endIdx);
                                                        let textAlign = "center";
                                                        if (alignSpec.includes('l')) {textAlign = "left";}
                                                        if (alignSpec.includes('r')) {textAlign = "right";}

                                                        // Arg 3: Content
                                                        currIdx = cellContent.indexOf('{', endIdx);
                                                        if (currIdx !== -1) {
                                                            endIdx = findBalancedClosingBrace(cellContent, currIdx);
                                                            if (endIdx !== -1) {
                                                                cellContent = cellContent.substring(currIdx + 1, endIdx);
                                                                cellAttrs += ` colspan="${colspan}" align="${textAlign}"`;
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    // Handle \multirow
                                    if (cellContent.startsWith('\\multirow')) {
                                        let currIdx = cellContent.indexOf('{'); // rows
                                        if (currIdx !== -1) {
                                            let endIdx = findBalancedClosingBrace(cellContent, currIdx);
                                            if (endIdx !== -1) {
                                                currIdx = cellContent.indexOf('{', endIdx); // width
                                                if (currIdx !== -1) {
                                                    endIdx = findBalancedClosingBrace(cellContent, currIdx);
                                                    if (endIdx !== -1) {
                                                        currIdx = cellContent.indexOf('{', endIdx); // content
                                                        if (currIdx !== -1) {
                                                            endIdx = findBalancedClosingBrace(cellContent, currIdx);
                                                            if (endIdx !== -1) {
                                                                cellContent = cellContent.substring(currIdx + 1, endIdx);
                                                                cellAttrs += ` style="vertical-align: middle;"`;
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    cellContent = cellContent.replace(/\\tnote\{([^}]+)\}/g, '<sup>$1</sup>');
                                    cellContent = resolveLatexStyles(cellContent);

                                    return `<td ${cellAttrs}>${renderer.renderInline(cellContent)}</td>`;
                                });

                                return `<tr>${cells.join('')}</tr>`;
                            }).join('');

                        tableHtml = `<table style="border-collapse: collapse; margin: 0 auto; width: 100%;">${rows}</table>`;
                    }
                }

                return `\n\n<div class="latex-block table">
                            ${captionHtml}
                            <div class="table-body">${tableHtml}</div>
                            ${notesHtml}
                        </div>\n\n`;
            });
        }
    },

    // --- Step 7: Theorem and proof environments ---
    {
        name: 'theorems_and_proofs',
        priority: 50,
        apply: (text, renderer: SmartRenderer) => {
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

    // --- Step 8: Metadata \maketitle and abstract ---
    {
        name: 'maketitle_and_abstract',
        priority: 60,
        apply: (text, renderer: SmartRenderer) => {
            // 1. Handle \maketitle
            if (text.includes('\\maketitle')) {
                let titleBlock = '';
                if (renderer.currentTitle) {titleBlock += `<h1 class="latex-title">${renderer.currentTitle}</h1>`;}
                if (renderer.currentAuthor) {titleBlock += `<div class="latex-author">${renderer.currentAuthor.replace(/\\\\/g, '<br/>')}</div>`;}
                text = text.replace(/\\maketitle.*/g, `\n\n${titleBlock}\n\n`);
            }

            // 2. Enhanced Abstract recognition
            text = text.replace(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/gi, (match, content) => {
                return `\n\nOOABSTRACT_STARTOO\n\n${content.trim()}\n\nOOABSTRACT_ENDOO\n\n`;
            });

            // 3. Keywords
            const keywordsRegex = /(?:\\begin\{keywords?\}([\s\S]*?)\\end\{keywords?\}|\\noindent\{\\bf Keywords\}:\s*(.*))/gi;
            text = text.replace(keywordsRegex, (match, contentA, contentB) => {
                const content = (contentA || contentB || '').trim();
                return `\n\nOOKEYWORDS_STARTOO${content}OOKEYWORDS_ENDOO\n\n`;
            });

            return text;
        }
    },

    // --- Step 9: Section titles ---
    {
        name: 'sections',
        priority: 70,
        apply: (text, renderer: SmartRenderer) => {
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

    // --- Step 12: List processing ---
    {
        name: 'lists',
        priority: 90,
        apply: (text, renderer: SmartRenderer) => {
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
        apply: (text, renderer: SmartRenderer) => {
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
        apply: (text, renderer: SmartRenderer) => {
            return resolveLatexStyles(text);
        }
    }
];

/**
 * Final HTML structure repair (Post-processing)
 */
export function postProcessHtml(html: string): string {
    html = html.replace(/<p>\s*OOABSTRACT_STARTOO\s*<\/p>/g, '<div class="latex-abstract"><span class="latex-abstract-title">Abstract</span>');
    html = html.replace(/OOABSTRACT_STARTOO/g, '<div class="latex-abstract"><span class="latex-abstract-title">Abstract</span>');
    html = html.replace(/<p>\s*OOABSTRACT_ENDOO\s*<\/p>/g, '</div>');
    html = html.replace(/OOABSTRACT_ENDOO/g, '</div>');

    const keywordRegex = /<p>\s*OOKEYWORDS_STARTOO([\s\S]*?)OOKEYWORDS_ENDOO\s*<\/p>/g;
    html = html.replace(keywordRegex, (match, content) => {
        return `<div class="latex-keywords"><strong>Keywords:</strong> ${content}</div>`;
    });
    return html;
}