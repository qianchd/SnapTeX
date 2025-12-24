import { toRoman, capitalizeFirstLetter, applyStyleToTexList, extractAndHideLabels, cleanLatexCommands, findBalancedClosingBrace, resolveLatexStyles } from './utils';
import { PreprocessRule } from './types';
import { SmartRenderer } from './renderer';
import { BibTexParser } from './bib';

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

    {
        name: 'mbox',
        priority: 20,
        apply: (text, renderer: SmartRenderer) => {
            return text.replace(/\\mbox/g, (match, char) => {
                return '\\text';
            });
        }
    },


    // --- Step 1: Roman numerals and special markers ---
    {
        name: 'romannumeral',
        priority: 30,
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
        priority: 40,
        apply: (text, renderer: SmartRenderer) => {
            const mathBlockRegex = /(\$\$([\s\S]*?)\$\$)|(\\\[([\s\S]*?)\\\])|(\\begin\{(equation|align|gather|multline|flalign|alignat)(\*?)\}([\s\S]*?)\\end\{\6\7\})/gi;

            return text.replace(mathBlockRegex, (match, m1, c1, m3, c4, m5, envName, star, c8, offset, fullString) => {
                if (offset > 0 && fullString[offset - 1] === '\\') {return match;}

                let content = c1 || c4 || c8 || match;

                // Placeholder
                let eqNumHTML = "";
                if (envName && star !== '*') {
                    eqNumHTML = `(<span class="sn-cnt" data-type="eq"></span>)`;
                }

                const { cleanContent, hiddenHtml } = extractAndHideLabels(content);
                let finalMath = cleanContent.trim();

                // [FIX] Use simple index token
                finalMath = finalMath.replace(/\\ref\*?\{([^}]+)\}/g, (m, key) => {
                    const token = renderer.pushProtectedRef(key);
                    return `\\text{${token}}`;
                });

                if (envName) {
                    const name = envName.toLowerCase();
                    if (['align', 'flalign', 'alignat', 'multline'].includes(name)) {
                        finalMath = `\\begin{aligned}\n${finalMath}\n\\end{aligned}`;
                    } else if (name === 'gather') {
                        finalMath = `\\begin{gathered}\n${finalMath}\n\\end{gathered}`;
                    }
                }

                const protectedTag = renderer.renderAndProtectMath(finalMath, true);
                const afterMatch = fullString.substring(offset + match.length);
                const isFollowedByText = /^\s*\S/.test(afterMatch) && !/^\s*\n\n/.test(afterMatch);

                if (eqNumHTML) {
                    return `<div class="equation-container" style="position: relative; width: 100%;">
                                ${protectedTag}
                                <span class="eq-no" style="position: absolute; right: 0; top: 50%; transform: translateY(-50%); pointer-events: none;">
                                    ${eqNumHTML}
                                </span>
                            </div>${hiddenHtml}` + (isFollowedByText ? '<span class="no-indent-marker"></span>' : '');
                } else {
                    return `${protectedTag}${hiddenHtml}` + (isFollowedByText ? '<span class="no-indent-marker"></span>' : '');
                }
            });
        }
    },

        // --- Step 6: Inline formula protection (Render and Cache) ---
    // Note: Priority 40 runs AFTER figure/table/algorithm, so it can catch math in their outputs.
    {
        name: 'inline_math',
        priority: 50,
        apply: (text, renderer: SmartRenderer) => {
            const processInline = (content: string) => {
                // [FIX] Use simple index token
                let safeContent = content.replace(/\\ref\*?\{([^}]+)\}/g, (m, key) => {
                    const token = renderer.pushProtectedRef(key);
                    return `\\text{${token}}`;
                });
                return renderer.renderAndProtectMath(safeContent, false);
            };

            // 1. \( ... \)
            text = text.replace(/\\\(([\s\S]*?)\\\)/gm, (match, content) => {
                return processInline(content);
            });

            // 2. $ ... $
            return text.replace(/(\\?)\$((?:\\.|[^\\$])*)\$/gm, (match, backslash, content) => {
                if (backslash === '\\') {return match;}
                return processInline(content);
            });
        }
    },


    // --- Step 13: Refs ---
    {
        name: 'refs_and_labels',
        priority: 60,
        apply: (text, renderer: SmartRenderer) => {
            // 1. Labels
            text = text.replace(/\\label\{([^}]+)\}/g, (match, labelName) => {
                const safeLabel = labelName.replace(/"/g, '&quot;');
                return `<span id="${safeLabel}" class="latex-label-anchor" data-label="${safeLabel}" style="position:relative; top:-50px; visibility:hidden;"></span>`;
            });

            // 2. References (Numbering)
            // [FIX] \ref just outputs link (number). \eqref outputs link wrapped in ()
            text = text.replace(/\\(ref|eqref)\*?\{([^}]+)\}/g, (match, type, labels) => {
                const labelArray = labels.split(',').map((l: string) => l.trim());
                const htmlLinks = labelArray.map((label: string) => {
                    return `<a href="#${label}" class="latex-link latex-ref sn-ref" data-key="${label}">?</a>`;
                });
                const joinedLinks = htmlLinks.join(', ');
                if (type === 'eqref') { return `(${joinedLinks})`; }
                return joinedLinks;
            });
            return text;
        }
    },

// --- Step 10: Author-Year Citations ---
    {
        name: 'citations',
        priority: 70,
        apply: (text, renderer: SmartRenderer) => {
            // [FIX] Updated Regex to CAPTURE optional arguments.
            // Group 2: Optional Arg 1, Group 3: Optional Arg 2, Group 4: Keys
            // Matches: \cite[post]{key}, \cite[pre][post]{key}
            const citeRegex = /\\(cite|citep|citet|citeyear)(?:\*?)(?:\s*\[([^\]]*)\])?(?:\s*\[([^\]]*)\])?\s*\{([^}]+)\}/g;

            text = text.replace(citeRegex, (match, cmd, opt1, opt2, keys) => {
                const keyArray = keys.split(',').map((k: string) => k.trim());

                // Logic for Optional Arguments
                let pre = '';
                let post = '';
                if (opt2 !== undefined) {
                    // Two args: [pre][post]
                    pre = opt1 ? opt1 + ' ' : '';
                    post = opt2;
                } else if (opt1 !== undefined) {
                    // One arg: [post]
                    post = opt1;
                }

                const parts = keyArray.map((key: string) => {
                    renderer.resolveCitation(key);
                    const entry = renderer.bibEntries.get(key);

                    if (!entry) {
                        return { error: true, key, author: "unknown", year: "unknown" };
                    }

                    const author = BibTexParser.getShortAuthor(entry);
                    const year = entry.fields.year || "unknown";
                    return { error: false, key, author, year };
                });

                const mkLink = (text: string, key: string) =>
                    `<a href="#ref-${key}" class="latex-cite-link" style="color:#2e7d32; text-decoration:none;">${text}</a>`;

                if (cmd === 'citet') {
                    // Format: pre Author (Year, post)
                    const formatted = parts.map((p: any, i: number) => {
                        const isLast = i === parts.length - 1;
                        if (p.error) {return `[${p.key}?]`;}

                        let yearText = p.year;
                        // For \citet, post-note usually goes inside the parenthesis of the last item
                        if (isLast && post) { yearText += `, ${post}`; }

                        return `${p.author} (${mkLink(yearText, p.key)})`;
                    }).join(', ');

                    return pre + formatted;

                } else if (cmd === 'citeyear') {
                    // Format: pre Year, post
                    const formatted = parts.map((p: any, i: number) => {
                        const isLast = i === parts.length - 1;
                        if (p.error) {return `[${p.key}?]`;}

                        let yearText = p.year;
                        if (isLast && post) { yearText += `, ${post}`; }

                        return mkLink(yearText, p.key);
                    }).join(', ');
                    return pre + formatted;

                } else {
                    // \cite or \citep -> (pre Author, Year, post)
                    const inner = parts.map((p: any) => {
                        if (p.error) {return `[${p.key}?]`;}
                        return mkLink(`${p.author}, ${p.year}`, p.key);
                    }).join('; ');

                    let content = inner;
                    if (pre) { content = pre + content; }
                    if (post) { content = content + ', ' + post; }

                    return `(${content})`;
                }
            });

            return text;
        }
    },

    // Step 11: Bibliography (Alphabetical, No Number) ---
    {
        name: 'bibliography',
        priority: 71,
        apply: (text, renderer: SmartRenderer) => {
            return text.replace(/\\bibliography\{([^}]+)\}/g, (match, file) => {
                if (renderer.citedKeys.length === 0) {
                    return `<div class="latex-bibliography error">No citations found.</div>`;
                }

                // 1. Get unique keys and Sort alphabetically by Author
                const uniqueKeys = Array.from(new Set(renderer.citedKeys));
                const sortedKeys = uniqueKeys.sort((a, b) => {
                    const entryA = renderer.bibEntries.get(a);
                    const entryB = renderer.bibEntries.get(b);
                    const authA = entryA ? (entryA.fields.author || '') : '';
                    const authB = entryB ? (entryB.fields.author || '') : '';
                    return authA.localeCompare(authB);
                });

                let html = `<h2 class="latex-bibliography-header">References</h2><div class="latex-bibliography-list">`;

                // 2. Render without numbers [n]
                sortedKeys.forEach((key) => {
                    const entry = renderer.bibEntries.get(key);
                    const content = entry
                        ? BibTexParser.formatEntry(entry, renderer)
                        : `<span style="color:red">Bib entry '${key}' not found.</span>`;

                    // Using a hanging indent style
                    html += `
                        <div class="bib-item" id="ref-${key}" style="margin-bottom: 0.8em; padding-left: 2em; text-indent: -2em;">
                            ${content}
                        </div>`;
                });

                html += `</div>`;
                return html;
            });
        }
    },

    {
        name: 'escaped_chars2',
        priority: 90,
        apply: (text, renderer: SmartRenderer) => {
            return text.replace(/\\([%#&])/g, (match, char) => {
                const entities: Record<string, string> = {'#': '&#35;', '&': '&amp;', '%': '&#37;' };
                // Keep using pushInlineProtected for raw text to avoid Markdown parsing
                return renderer.pushInlineProtected(entities[char] || char);
            });
        }
    },

    {
    name: 'latex_quotes',
    priority: 100,
        apply: (text, renderer: SmartRenderer) => {
            // 1. 处理双引号 ``content''
            // 注意：这里我们只通过正则找到对儿，但替换时只替换符号，保持 content 在外面
            let processed = text.replace(/``([\s\S]*?)''/g, (match, content) => {
                const open = renderer.pushInlineProtected('&ldquo;');
                const close = renderer.pushInlineProtected('&rdquo;');
                // 重要：返回时 content 依然是裸露的，这样它里面的 $a=1$ 占位符才能被后续还原
                return `${open}${content}${close}`;
            });

            // 2. 处理单引号 `content'
            processed = processed.replace(/`([\s\S]*?)'/g, (match, content) => {
                const open = renderer.pushInlineProtected('&lsquo;');
                const close = renderer.pushInlineProtected('&rsquo;');
                return `${open}${content}${close}`;
            });

            // 1. 处理双引号 `` ... ''
            processed = processed.replace(/``/g, () => renderer.pushInlineProtected('&ldquo;'));
            // processed = processed.replace(/''/g, () => renderer.pushInlineProtected('&rdquo;'));

            // 2. 处理单引号 ` ... '
            // 注意：为了安全，可以只匹配前面有空格或开头的 `，以及后面有空格或标点的 '
            processed = processed.replace(/`/g, () => renderer.pushInlineProtected('&lsquo;'));
            // processed = processed.replace(/'/g, () => renderer.pushInlineProtected('&rsquo;'));

            return processed;
        }
    },

    // --- Step 0.5: Handle LaTeX special spaces (~) ---
    // Fix: Prevent ~~~~~~ from being parsed as Markdown strikethrough (~~).
    // Convert ~ to non-breaking space (&nbsp;) and protect it.
    {
        name: 'latex_special_spaces',
        priority: 110,
        apply: (text, renderer: SmartRenderer) => {
            // Global replace tilde with protected non-breaking space
            return text.replace(/~/g, () => renderer.pushInlineProtected('&nbsp;'));
        }
    },

    // --- Step 3: Figure (Enhanced with PDF support) ---
    // Note: Priority 33 ensures it runs after display_math(30) but before inline_math(40).
    {
        name: 'figure',
        priority: 120,
        apply: (text: string, renderer: SmartRenderer) => {
            return text.replace(/\\begin\{figure\}(?:\[.*?\])?([\s\S]*?)\\end\{figure\}/gi, (match, content) => {
                const captionMatch = content.match(/\\caption\{([^}]+)\}/);
                // [NEW] Placeholder for Figure Number
                const caption = captionMatch ?
                    `<div class="figure-caption"><strong>Figure <span class="sn-cnt" data-type="fig"></span>:</strong> ${cleanLatexCommands(captionMatch[1], renderer)}</div>` : '';

                const imgMatch = content.match(/\\includegraphics(?:\[.*?\])?\{([^}]+)\}/);
                const imgPath = imgMatch ? imgMatch[1] : '';
                let inner = `[Image Not Found]`;
                if (imgPath) {
                    if (imgPath.toLowerCase().endsWith('.pdf')) {
                        const canvasId = `pdf-${Math.random().toString(36).substr(2, 9)}`;
                        inner = `<canvas id="${canvasId}" data-pdf-src="LOCAL_IMG:${imgPath}" style="width:100%; max-width:100%; display:block; margin:0 auto;"></canvas>`;
                    } else {
                        inner = `<img src="LOCAL_IMG:${imgPath}" style="max-width:100%; display:block; margin:0 auto;">`;
                    }
                }
                return `\n\n<div class="latex-block figure">${inner}${caption}</div>\n\n`;
            });
        }
    },

    // --- Step 4: Algorithm (Priority 35) ---
    {
        name: 'algorithm',
        priority: 130,
        apply: (text: string, renderer: SmartRenderer) => {
            return text.replace(/\\begin\{algorithm\}(?:\[.*?\])?([\s\S]*?)\\end\{algorithm\}/gi, (match, content) => {
                const captionMatch = content.match(/\\caption\{([^}]+)\}/);
                let captionText = captionMatch ? captionMatch[1] : '';
                if (captionText) {captionText = captionText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => renderer.renderAndProtectMath(c.trim(), false));}

                // [NEW] Placeholder
                const captionHtml = captionText ?
                    `<div class="alg-caption"><strong>Algorithm <span class="sn-cnt" data-type="alg"></span>:</strong> ${renderer.renderInline(captionText)}</div>` : '';

                // ... (Algorithmic Logic 保持不变，省略以节省篇幅) ...
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
                        if(!trimmed || trimmed.startsWith('%') || trimmed.startsWith('\\renewcommand') || trimmed.startsWith('\\setlength')) {return;}

                        let prefixHtml = "";
                        let contentToRender = trimmed;
                        let isSpecialLine = false;
                        if (trimmed.match(/^\\(Require|Ensure|Input|Output)/)) {
                             const isInput = trimmed.match(/^\\(Require|Input)/);
                             const label = isInput ? 'Input:' : 'Output:';
                             prefixHtml = `<strong>${label}</strong> `;
                             contentToRender = trimmed.replace(/^\\(Require|Ensure|Input|Output)\s*/, '');
                             isSpecialLine = true;
                        } else if (trimmed.match(/^\\State/)) {
                             contentToRender = trimmed.replace(/^\\State\s*/, '');
                             if (contentToRender.startsWith('{') && contentToRender.endsWith('}')) {contentToRender = contentToRender.substring(1, contentToRender.length - 1);}
                        }

                        contentToRender = resolveLatexStyles(contentToRender);

                        // Handle \eqref
                        contentToRender = contentToRender.replace(/\\eqref\*?\{([^}]+)\}/g, (match, labels) => {
                            const labelArray = labels.split(',').map((l: string) => l.trim());
                            return labelArray.map((label: string) =>
                                `(<a href="#${label}" class="latex-link latex-ref sn-ref" data-key="${label}">?</a>)`
                            ).join(', ');
                        });

                        // Handle \ref
                        contentToRender = contentToRender.replace(/\\ref\*?\{([^}]+)\}/g, (match, labels) => {
                            const labelArray = labels.split(',').map((l: string) => l.trim());
                            return labelArray.map((label: string) =>
                                `<a href="#${label}" class="latex-link latex-ref sn-ref" data-key="${label}">?</a>`
                            ).join(', ');
                        });

                        contentToRender = contentToRender.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => renderer.renderAndProtectMath(c.trim(), false));
                        const renderedContent = renderer.renderInline(contentToRender);
                        const itemClass = isSpecialLine ? "alg-item alg-item-no-marker" : "alg-item";
                        listItems += `<li class="${itemClass}">${prefixHtml}${renderedContent}</li>`;
                    });
                    bodyHtml += `<${listTag} class="alg-list">${listItems}</${listTag}>`;
                }
                return `\n\n<div class="latex-block algorithm">${captionHtml}${bodyHtml}<div class="alg-bottom-rule"></div></div>\n\n`;
            });
        }
    },

    // --- Step 5: Table (Priority 36) ---
    {
        name: 'table',
        priority: 140,
        apply: (text: string, renderer: SmartRenderer) => {
            return text.replace(/\\begin\{table\}(?:\[.*?\])?([\s\S]*?)\\end\{table\}/gi, (match, content) => {
                const captionMatch = content.match(/\\caption\{([^}]+)\}/);
                let captionText = captionMatch ? captionMatch[1] : '';
                if (captionText) {
                    captionText = captionText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => renderer.renderAndProtectMath(c.trim(), false));
                    captionText = resolveLatexStyles(captionText);
                }
                // [NEW] Placeholder
                const captionHtml = captionText ?
                    `<div class="table-caption"><strong>Table <span class="sn-cnt" data-type="tbl"></span>:</strong> ${renderer.renderInline(captionText)}</div>` : '';

                // ... (Table logic kept strictly same as before) ...
                let innerContent = content.replace(/\\begin\{threeparttable\}/g, '').replace(/\\end\{threeparttable\}/g, '');
                let notesHtml = '';
                const notesMatch = innerContent.match(/\\begin\{tablenotes\}(?:\[.*?\])?([\s\S]*?)\\end\{tablenotes\}/);
                if (notesMatch) {
                    let notesBody = notesMatch[1];
                    innerContent = innerContent.replace(notesMatch[0], '');
                    notesBody = notesBody.replace(/\\(footnotesize|small|scriptsize|tiny)/g, '');
                    const noteItems = notesBody.split('\\item').slice(1).map((item: string) => {
                            let itemText = item;
                            let labelHtml = '';
                            const lblMatch = item.match(/^\s*\[(.*?)\]/);
                            if (lblMatch) {
                                let labelContent = lblMatch[1];
                                labelContent = labelContent.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => renderer.renderAndProtectMath(c.trim(), false));
                                labelContent = resolveLatexStyles(labelContent);
                                labelHtml = `<strong>${renderer.renderInline(labelContent)}</strong> `;
                                itemText = item.substring(lblMatch[0].length);
                            }
                            itemText = itemText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => renderer.renderAndProtectMath(c.trim(), false));
                            itemText = resolveLatexStyles(itemText);
                            return `<li class="note-item" style="list-style:none">${labelHtml}${renderer.renderInline(itemText.trim())}</li>`;
                        }).join('');
                    notesHtml = `<div class="latex-tablenotes"><ul>${noteItems}</ul></div>`;
                }
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
                let tableHtml = '';
                const beginRegex = /\\begin\{tabular(\*?)\}/g;
                const beginMatch = beginRegex.exec(innerContent);
                if (beginMatch) {
                    const isStar = beginMatch[1] === '*';
                    let contentStartIndex = beginMatch.index + beginMatch[0].length;
                    const requiredArgs = isStar ? 2 : 1;
                    let argsFound = 0;
                    while (argsFound < requiredArgs) {
                        while(contentStartIndex < innerContent.length && /\s/.test(innerContent[contentStartIndex])) {contentStartIndex++;}
                        if (contentStartIndex >= innerContent.length) {break;}
                        if (innerContent[contentStartIndex] === '[') {
                            const closeBracket = innerContent.indexOf(']', contentStartIndex);
                            if (closeBracket !== -1) { contentStartIndex = closeBracket + 1; continue; }
                        }
                        if (innerContent[contentStartIndex] === '{') {
                            const closeBrace = findBalancedClosingBrace(innerContent, contentStartIndex);
                            if (closeBrace !== -1) { contentStartIndex = closeBrace + 1; argsFound++; } else { break; }
                        } else { break; }
                    }
                    const endRegex = /\\end\{tabular\*?\}/g;
                    endRegex.lastIndex = contentStartIndex;
                    const endMatch = endRegex.exec(innerContent);
                    if (endMatch) {
                        let rawContent = innerContent.substring(contentStartIndex, endMatch.index);
                        rawContent = rawContent.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: String, c: String) => renderer.renderAndProtectMath(c.trim(), false));
                        rawContent = rawContent.replace(/\\(toprule|midrule|bottomrule|hline|centering|raggedright|raggedleft)/g, '');
                        rawContent = rawContent.replace(/\\cmidrule(?:\[.*?\])?(?:\(.*?\))?\{[^}]+\}/g, '');
                        rawContent = rawContent.replace(/\\cline\{[^}]+\}/g, '');
                        rawContent = rawContent.replace(/\\vspace\*?\{[^}]+\}/g, '');
                        rawContent = rawContent.replace(/\\setlength\\[a-zA-Z]+\{[^}]+\}/g, '');
                        rawContent = rawContent.replace(/%.*$/gm, '');
                        const rows = rawContent.split(/\\\\(?:\[.*?\])?/).filter((r: string) => r.trim().length > 0).map((rowText: string) => {
                                const cells = rowText.split('&').map((c: string) => {
                                    let cellContent = c.trim();
                                    let cellAttrs = 'style="padding: 5px 10px; border: 1px solid #ddd;"';
                                    if (cellContent.startsWith('\\multicolumn')) {
                                        let currIdx = cellContent.indexOf('{');
                                        if (currIdx !== -1) {
                                            let endIdx = findBalancedClosingBrace(cellContent, currIdx);
                                            if (endIdx !== -1) {
                                                const colspan = cellContent.substring(currIdx + 1, endIdx);
                                                currIdx = cellContent.indexOf('{', endIdx);
                                                if (currIdx !== -1) {
                                                    endIdx = findBalancedClosingBrace(cellContent, currIdx);
                                                    if (endIdx !== -1) {
                                                        const alignSpec = cellContent.substring(currIdx + 1, endIdx);
                                                        let textAlign = "center";
                                                        if (alignSpec.includes('l')) {textAlign = "left";}
                                                        if (alignSpec.includes('r')) {textAlign = "right";}
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
                                    if (cellContent.startsWith('\\multirow')) {
                                        let currIdx = cellContent.indexOf('{');
                                        if (currIdx !== -1) {
                                            let endIdx = findBalancedClosingBrace(cellContent, currIdx);
                                            if (endIdx !== -1) {
                                                currIdx = cellContent.indexOf('{', endIdx);
                                                if (currIdx !== -1) {
                                                    endIdx = findBalancedClosingBrace(cellContent, currIdx);
                                                    if (endIdx !== -1) {
                                                        currIdx = cellContent.indexOf('{', endIdx);
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
                return `\n\n<div class="latex-block table">${captionHtml}<div class="table-body">${tableHtml}</div>${notesHtml}</div>\n\n`;
            });
        }
    },

    // --- Step 7: Theorem and proof environments ---
    {
        name: 'theorems_and_proofs',
        priority: 150,
        apply: (text, renderer: SmartRenderer) => {
            const thmEnvs = ['theorem', 'lemma', 'proposition', 'condition', 'condbis', 'assumption', 'remark', 'definition', 'corollary', 'example'].join('|');
            const thmRegex = new RegExp(`\\\\begin\\{(${thmEnvs})\\}(?:\\{.*?\\})?(?:\\[(.*?)\\])?([\\s\\S]*?)\\\\end\\{\\1\\}`, 'gi');
            text = text.replace(thmRegex, (match, envName, optArg, content) => {
                const displayName = capitalizeFirstLetter(envName);
                // [NEW] Placeholder
                let header = `\n<span class="latex-thm-head"><strong class="latex-theorem-header">${displayName} <span class="sn-cnt" data-type="thm"></span></strong>`;
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
        priority: 160,
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
        priority: 170,
        apply: (text, renderer: SmartRenderer) => {
            const sectionRegex = /\\(section|subsection|subsubsection)(\*?)\{((?:[^{}]|{[^{}]*})*)\}\s*(\\label\{[^}]+\})?\s*/g;
            return text.replace(sectionRegex, (match, level, star, content, label) => {
                // [NEW] Placeholder
                const prefix = level === 'section' ? '##' : (level === 'subsection' ? '###' : '####');
                let numHtml = "";
                if (star !== '*') {
                    numHtml = `<span class="sn-cnt" data-type="sec"></span> `;
                }

                let anchor = "";
                if (label) {
                    const labelName = label.match(/\{([^}]+)\}/)?.[1] || "";
                    anchor = `<span id="${labelName}" class="latex-label-anchor"></span>`;
                }
                return `\n${prefix} ${numHtml}${content.trim()} ${anchor}\n`;
            });
        }
    },

    // --- Step 12: List processing ---
    {
        name: 'lists',
        priority: 180,
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

    // --- Step 13: Text Styles ---
    {
        name: 'text_styles',
        priority: 190,
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