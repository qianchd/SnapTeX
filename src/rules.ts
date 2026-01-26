import { toRoman, capitalizeFirstLetter, extractAndHideLabels, findBalancedClosingBrace, resolveLatexStyles, findCommand } from './utils';
import { PreprocessRule } from './types';
import { SmartRenderer } from './renderer';
import { BibTexParser } from './bib';
import { REGEX_STR, R_LABEL, R_REF, R_CITATION, R_BIBLIOGRAPHY } from './patterns';
import katex from 'katex';

/**
 * Helper to render math using KaTeX and protect it.
 */
function renderMath(tex: string, displayMode: boolean, renderer: SmartRenderer): string {
    try {
        const html = katex.renderToString(tex, {
            displayMode: displayMode,
            macros: renderer.currentMacros,
            throwOnError: false,
            errorColor: '#cc0000',
            globalGroup: true,
            trust: true
        });
        return renderer.protect('math', html);
    } catch (e) {
        return renderer.protect('math', `<span style="color:red">Math Error</span>`);
    }
}

/**
 * Helper to create a protected reference link
 */
function createRefLink(key: string, renderer: SmartRenderer, type: 'ref' | 'eqref' = 'ref'): string {
    const html = `<a href="#${key}" class="sn-ref" data-key="${key}" style="color:inherit; text-decoration:none;">?</a>`;
    const token = renderer.protect('ref', html);
    if (type === 'eqref') {
        return `(\\text{${token}})`;
    }
    return `\\text{${token}}`;
}

/**
 * [NEW] Scans text for protection tokens (like hidden labels) that might be floating
 * outside the main content (e.g. \label after \caption or \includegraphics).
 */
function recoverPreservedTokens(text: string): string {
    // Matches tokens format defined in ProtectionManager: ｢SNAP:namespace:id｣
    const tokenRegex = /｢SNAP:[a-zA-Z0-9_-]+:\d+｣/g;
    let found = "";
    let match;
    while ((match = tokenRegex.exec(text)) !== null) {
        found += match[0];
    }
    return found;
}

export const DEFAULT_PREPROCESS_RULES: PreprocessRule[] = [
    // Removes the % marker left by metadata.ts and consumes the following newline.
    // This mimics LaTeX behavior: "Word%\nNext" -> "WordNext" (joined).
    // "Line\n%\nLine" -> "Line\nLine" -> Rendered as "Line Line" (space).
    {
        name: 'clean_comments',
        priority: 5,
        apply: (text, renderer: SmartRenderer) => {
            return text.replace(/(?<!\\)%.*(\r?\n)?/g, '');
        }
    },
    // --- Step 0: Handle escape characters (Highest priority, prevents interference with subsequent regex) ---
    {
        name: 'escaped_char_dollar',
        priority: 10,
        apply: (text, renderer: SmartRenderer) => {
            return text.replace(/\\([$])/g, (match, char) => {
                const entities: Record<string, string> = { '$': '&#36;' };
                return renderer.protect('raw', entities[char] || char);
            });
        }
    },

    {
        name: 'mbox',
        priority: 20,
        apply: (text, renderer: SmartRenderer) => {
            return text.replace(/\\mbox/g, '\\text');
        }
    },

    // --- Step 1: Roman numerals ---
    {
        name: 'romannumeral',
        priority: 30,
        apply: (text, renderer: SmartRenderer) => {
            text = text.replace(/\\(Rmnum|rmnum|romannumeral)\s*\{?(\d+)\}?/g, (match, cmd, numStr) => {
                return toRoman(parseInt(numStr), cmd === 'Rmnum');
            });
            return text.replace(/\\noindent\s*/g, () => renderer.protect('raw', '<span class="no-indent-marker"></span>'));
        }
    },

    // --- Step 2: Block-level math formulas ---
    {
        name: 'display_math',
        priority: 40,
        apply: (text, renderer: SmartRenderer) => {
            const mathBlockRegex = new RegExp(
                `(\\$\\$([\\s\\S]*?)\\$\\$)|(\\\\\\[([\\s\\S]*?)\\\\\\])|(\\\\begin\\{(${REGEX_STR.MATH_ENVS})(\\*?)\\}([\\s\\S]*?)\\\\end\\{\\6\\7\\})`,
                'gi'
            );

            return text.replace(mathBlockRegex, (match, m1, c1, m3, c4, m5, envName, star, c8, offset, fullString) => {
                if (offset > 0 && fullString[offset - 1] === '\\') { return match; }

                let content = c1 || c4 || c8 || match;

                // Placeholder
                let eqNumHTML = "";
                if (envName && star !== '*') {
                    eqNumHTML = `(<span class="sn-cnt" data-type="eq"></span>)`;
                }

                const { cleanContent, hiddenHtml } = extractAndHideLabels(content);
                let finalMath = cleanContent.trim();

                // Handle nested refs inside math
                finalMath = finalMath.replace(/\\(ref|eqref)\*?\{([^}]+)\}/g, (m, reftype, key) => createRefLink(key, renderer, reftype as any));

                if (envName) {
                    const name = envName.toLowerCase();
                    if (['align', 'flalign', 'alignat', 'multline'].includes(name)) {
                        finalMath = `\\begin{aligned}\n${finalMath}\n\\end{aligned}`;
                    } else if (name === 'gather') {
                        finalMath = `\\begin{gathered}\n${finalMath}\n\\end{gathered}`;
                    }
                }

                const protectedTag = renderMath(finalMath, true, renderer);

                const afterMatch = fullString.substring(offset + match.length);
                const isFollowedByText = /^\s*\S/.test(afterMatch) && !/^\s*\n\n/.test(afterMatch);

                let result = protectedTag + hiddenHtml;
                if (eqNumHTML) {
                    result = `<div class="equation-container" style="position: relative; width: 100%;">
                                ${protectedTag}
                                <span class="eq-no" style="position: absolute; right: 0; top: 50%; transform: translateY(-50%); pointer-events: none;">
                                    ${eqNumHTML}
                                </span>
                            </div>${hiddenHtml}`;
                }
                return result + (isFollowedByText ? '<span class="no-indent-marker"></span>' : '');
            });
        }
    },

    // --- Step 6: Inline formula ---
    {
        name: 'inline_math',
        priority: 50,
        apply: (text, renderer: SmartRenderer) => {
            const processInline = (content: string) => {
                let safeContent = content.replace(/\\(ref|eqref)\*?\{([^}]+)\}/g, (m, reftype, key) => {
                    return createRefLink(key, renderer, reftype as any);
                });
                return renderMath(safeContent, false, renderer);
            };

            text = text.replace(/\\\(([\s\S]*?)\\\)/gm, (match, content) => processInline(content));
            return text.replace(/(\\?)\$((?:\\.|[^\\$])*)\$/gm, (match, backslash, content) => {
                if (backslash === '\\') { return match; }
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
            text = text.replace(new RegExp(R_LABEL, 'g'), (match, labelName) => {
                const safeLabel = labelName.replace(/"/g, '&quot;');
                // Protect raw HTML anchors so they survive inside Figure/Table blocks
                return renderer.protect('raw', `<span id="${safeLabel}" class="latex-label-anchor" data-label="${safeLabel}" style="position:relative; top:-50px; visibility:hidden;"></span>`);
            });

            // 2. References (Numbering)
            text = text.replace(R_REF, (match, type, labels) => {
                const labelArray = labels.split(',').map((l: string) => l.trim());
                const htmlLinks = labelArray.map((label: string) => {
                    return `<a href="#${label}" class="latex-link latex-ref sn-ref" data-key="${label}">?</a>`;
                });
                const joinedLinks = htmlLinks.join(', ');
                const result = (type === 'eqref') ? `(${joinedLinks})` : joinedLinks;
                return renderer.protect('ref', result);
            });
            return text;
        }
    },

    // --- Step 10: Citations ---
    {
        name: 'citations',
        priority: 70,
        apply: (text, renderer: SmartRenderer) => {
            text = text.replace(R_CITATION, (match, cmd, opt1, opt2, keys) => {
                const keyArray = keys.split(',').map((k: string) => k.trim());
                let pre = '';
                let post = '';
                if (opt2 !== undefined) { pre = opt1 ? opt1 + ' ' : ''; post = opt2; }
                else if (opt1 !== undefined) { post = opt1; }

                const parts = keyArray.map((key: string) => {
                    renderer.resolveCitation(key);
                    const entry = renderer.bibEntries.get(key);
                    if (!entry) { return { error: true, key, author: "unknown", year: "unknown" }; }
                    const author = BibTexParser.getShortAuthor(entry);
                    const year = entry.fields.year || "unknown";
                    return { error: false, key, author, year };
                });

                const mkLink = (text: string, key: string) =>
                    `<a href="#ref-${key}" class="latex-cite-link" style="color:#2e7d32; text-decoration:none;">${text}</a>`;

                let finalHtml = "";
                if (cmd === 'citet') {
                    const formatted = parts.map((p: any, i: number) => {
                        const isLast = i === parts.length - 1;
                        if (p.error) { return `[${p.key}?]`; }
                        let yearText = p.year;
                        if (isLast && post) { yearText += `, ${post}`; }
                        return `${p.author} (${mkLink(yearText, p.key)})`;
                    }).join(', ');
                    finalHtml = pre + formatted;
                } else if (cmd === 'citeyear') {
                    const formatted = parts.map((p: any, i: number) => {
                        const isLast = i === parts.length - 1;
                        if (p.error) { return `[${p.key}?]`; }
                        let yearText = p.year;
                        if (isLast && post) { yearText += `, ${post}`; }
                        return mkLink(yearText, p.key);
                    }).join(', ');
                    finalHtml = pre + formatted;
                } else {
                    const inner = parts.map((p: any) => {
                        if (p.error) { return `[${p.key}?]`; }
                        return mkLink(`${p.author}, ${p.year}`, p.key);
                    }).join('; ');
                    let content = inner;
                    if (pre) { content = pre + content; }
                    if (post) { content = content + ', ' + post; }
                    finalHtml = `(${content})`;
                }

                return renderer.protect('cite', finalHtml);
            });
            return text;
        }
    },

    // Step 11: Bibliography ---
    {
        name: 'bibliography',
        priority: 71,
        apply: (text, renderer: SmartRenderer) => {
            return text.replace(new RegExp(R_BIBLIOGRAPHY, 'g'), (match, file) => {
                if (renderer.citedKeys.length === 0) {
                    return `<div class="latex-bibliography error">No citations found.</div>`;
                }
                const uniqueKeys = Array.from(new Set(renderer.citedKeys));
                const sortedKeys = uniqueKeys.sort((a, b) => {
                    const entryA = renderer.bibEntries.get(a);
                    const entryB = renderer.bibEntries.get(b);
                    const authA = entryA ? (entryA.fields.author || '') : '';
                    const authB = entryB ? (entryB.fields.author || '') : '';
                    return authA.localeCompare(authB);
                });

                let html = `<h2 class="latex-bibliography-header">References</h2><div class="latex-bibliography-list">`;
                sortedKeys.forEach((key) => {
                    const entry = renderer.bibEntries.get(key);
                    const content = entry
                        ? BibTexParser.formatEntry(entry, renderer)
                        : `<span style="color:red">Bib entry '${key}' not found.</span>`;
                    html += `<div class="bib-item" id="ref-${key}" style="margin-bottom: 0.8em; padding-left: 2em; text-indent: -2em;">${content}</div>`;
                });
                html += `</div>`;
                return renderer.protect('bib', html);
            });
        }
    },

    {
        name: 'escaped_chars2',
        priority: 90,
        apply: (text, renderer: SmartRenderer) => {
            return text.replace(/\\([%#&])/g, (match, char) => {
                const entities: Record<string, string> = { '#': '&#35;', '&': '&amp;', '%': '&#37;' };
                return renderer.protect('raw', entities[char] || char);
            });
        }
    },

    {
        name: 'latex_quotes',
        priority: 100,
        apply: (text, renderer: SmartRenderer) => {
            let processed = text.replace(/``([\s\S]*?)''/g, (match, content) => {
                const open = renderer.protect('quote', '&ldquo;');
                const close = renderer.protect('quote', '&rdquo;');
                return `${open}${content}${close}`;
            });
            processed = processed.replace(/`([\s\S]*?)'/g, (match, content) => {
                const open = renderer.protect('quote', '&lsquo;');
                const close = renderer.protect('quote', '&rsquo;');
                return `${open}${content}${close}`;
            });
            processed = processed.replace(/``/g, () => renderer.protect('quote', '&ldquo;'));
            processed = processed.replace(/`/g, () => renderer.protect('quote', '&lsquo;'));
            return processed;
        }
    },

    {
        name: 'latex_special_spaces',
        priority: 110,
        apply: (text, renderer: SmartRenderer) => {
            return text.replace(/~/g, () => renderer.protect('space', '&nbsp;'));
        }
    },

// --- Step 3: Figure (Structure Extraction + Label Recovery) ---
    {
        name: 'figure',
        priority: 120,
        apply: (text: string, renderer: SmartRenderer) => {
            return text.replace(/\\begin\{figure\}(?:\[.*?\])?([\s\S]*?)\\end\{figure\}/gi, (match, content) => {
                // 1. Extract Caption
                const captionRes = findCommand(content, 'caption');
                let captionHtml = '';
                let body = content;

                if (captionRes) {
                    let captionText = captionRes.content;
                    captionText = captionText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: string, c: string) => renderMath(c.trim(), false, renderer));
                    captionText = resolveLatexStyles(captionText);
                    captionHtml = `<div class="figure-caption"><strong>Figure <span class="sn-cnt" data-type="fig"></span>:</strong> ${renderer.renderInline(captionText)}</div>`;
                    // Remove caption from body to avoid duplication
                    body = body.substring(0, captionRes.start) + body.substring(captionRes.end + 1);
                }

                // 2. Extract Image
                const imgMatch = body.match(/\\includegraphics(?:\[.*?\])?\{([^}]+)\}/);
                let inner = '';
                if (imgMatch) {
                    const imgPath = imgMatch[1].trim();
                    const canvasId = `pdf-${Math.random().toString(36).substr(2, 9)}`;
                    inner = imgPath.toLowerCase().endsWith('.pdf')
                        ? `<canvas id="${canvasId}" data-req-path="${imgPath}" style="width:100%; max-width:100%; display:block; margin:0 auto;"></canvas>`
                        : `<img src="LOCAL_IMG:${imgPath}" style="max-width:100%; display:block; margin:0 auto;">`;
                } else {
                    // Only show placeholder if body is emptyish AND no image found
                    if (body.replace(/\s/g, '').length === 0) {
                        inner = `<div style="border:1px dashed #ccc; padding:10px; color:#666;">[Image Not Found or Empty Figure]</div>`;
                    }
                }

                // 3. [FIX] Recover "lost" labels
                // Since \label has already been turned into a token by the 'refs_and_labels' rule (priority 60),
                // it looks like ｢SNAP:raw:5｣ in the 'body' string.
                // We scan 'body' for these tokens and append them so the anchor exists in the HTML.
                const hiddenLabels = recoverPreservedTokens(body);

                // Reconstruct clean HTML
                return `\n\n` + renderer.protect('fig', `<div class="latex-block figure">${inner}${captionHtml}${hiddenLabels}</div>`) + `\n\n`;
            });
        }
    },

    // --- Step 4: Algorithm (Structure Extraction + Label Recovery) ---
    {
        name: 'algorithm',
        priority: 130,
        apply: (text: string, renderer: SmartRenderer) => {
            return text.replace(/\\begin\{algorithm\}(?:\[.*?\])?([\s\S]*?)\\end\{algorithm\}/gi, (match, content) => {
                const captionRes = findCommand(content, 'caption');
                let captionHtml = '';
                if (captionRes) {
                    let captionText = captionRes.content;
                    captionText = captionText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: string, c: string) => renderMath(c.trim(), false, renderer));
                    captionText = resolveLatexStyles(captionText);
                    captionHtml = `<div class="alg-caption"><strong>Algorithm <span class="sn-cnt" data-type="alg"></span>:</strong> ${renderer.renderInline(captionText)}</div>`;
                    content = content.substring(0, captionRes.start) + content.substring(captionRes.end + 1);
                }

                const algRegex = /\\begin\{algorithmic\}(?:\[(.*?)\])?([\s\S]*?)\\end\{algorithmic\}/g;
                let bodyHtml = '';
                let matchAlg;
                // We keep track of where matches were found to extract labels from the *rest* of the content later
                let processedRegions: {start: number, end: number}[] = [];

                while ((matchAlg = algRegex.exec(content)) !== null) {
                    processedRegions.push({start: matchAlg.index, end: matchAlg.index + matchAlg[0].length});
                    const params = matchAlg[1] || '';
                    const rawBody = matchAlg[2];
                    const showNumbers = params.includes('1');
                    const listTag = showNumbers ? 'ol' : 'ul';
                    const lines = rawBody.split('\n');
                    let listItems = '';

                    lines.forEach(line => {
                        let trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith('%') || trimmed.startsWith('\\renewcommand') || trimmed.startsWith('\\setlength')) { return; }

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
                            if (contentToRender.startsWith('{') && contentToRender.endsWith('}')) { contentToRender = contentToRender.substring(1, contentToRender.length - 1); }
                        }

                        // Labels inside the algorithmic block are handled here
                        // We also need to preserve them inside the lines
                        const lineLabels = recoverPreservedTokens(contentToRender);
                        // Clean tokens from content to avoid double rendering (though tokens render as tokens, so safe)
                        // Actually, renderInline will pass tokens through.

                        contentToRender = resolveLatexStyles(contentToRender);
                        const renderedContent = renderer.renderInline(contentToRender);
                        const itemClass = isSpecialLine ? "alg-item alg-item-no-marker" : "alg-item";
                        listItems += `<li class="${itemClass}">${prefixHtml}${renderedContent}</li>`;
                    });

                    bodyHtml += `<${listTag} class="alg-list">${listItems}</${listTag}>`;
                }

                // 3. [FIX] Recover labels that were OUTSIDE the algorithmic block (e.g. \label after \end{algorithmic})
                // We construct a string of "ignored" content
                let ignoredContent = "";
                let lastIdx = 0;
                processedRegions.forEach(reg => {
                    ignoredContent += content.substring(lastIdx, reg.start);
                    lastIdx = reg.end;
                });
                ignoredContent += content.substring(lastIdx);

                const hiddenLabels = recoverPreservedTokens(ignoredContent);

                return `\n\n` + renderer.protect('alg', `<div class="latex-block algorithm">${captionHtml}${bodyHtml}${hiddenLabels}<div class="alg-bottom-rule"></div></div>`) + `\n\n`;
            });
        }
    },

    // --- Step 5: Table (Structure Extraction + Label Recovery) ---
    {
        name: 'table',
        priority: 140,
        apply: (text: string, renderer: SmartRenderer) => {
            return text.replace(/\\begin\{table(\*?)\}(?:\[.*?\])?([\s\S]*?)\\end\{table\1\}/gi, (match, star, content) => {
                const captionRes = findCommand(content, 'caption');
                let captionHtml = '';

                if (captionRes) {
                    let captionText = captionRes.content;
                    captionText = captionText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: string, c: string) => renderMath(c.trim(), false, renderer));
                    captionText = resolveLatexStyles(captionText);
                    captionHtml = `<div class="table-caption"><strong>Table <span class="sn-cnt" data-type="tbl"></span>:</strong> ${renderer.renderInline(captionText)}</div>`;
                    content = content.substring(0, captionRes.start) + content.substring(captionRes.end + 1);
                }

                let innerContent = content.replace(/\\begin\{threeparttable\}/g, '').replace(/\\end\{threeparttable\}/g, '');
                let notesHtml = '';
                const notesMatch = innerContent.match(/\\begin\{tablenotes\}(?:\[.*?\])?([\s\S]*?)\\end\{tablenotes\}/);

                if (notesMatch) {
                    let notesBody = notesMatch[1].replace(/\\(footnotesize|small|scriptsize|tiny)/g, '');
                    innerContent = innerContent.replace(notesMatch[0], '');
                    const noteItems = notesBody.split('\\item').slice(1).map((item: string) => {
                        let itemText = item;
                        let labelHtml = '';
                        const lblMatch = item.match(/^\s*\[(.*?)\]/);
                        if (lblMatch) {
                            labelHtml = `<strong>${renderer.renderInline(lblMatch[1])}</strong> `;
                            itemText = item.substring(lblMatch[0].length);
                        }
                        itemText = itemText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: string, c: string) => renderMath(c.trim(), false, renderer));
                        return `<li class="note-item" style="list-style:none">${labelHtml}${renderer.renderInline(itemText.trim())}</li>`;
                    }).join('');
                    notesHtml = `<div class="latex-tablenotes"><ul>${noteItems}</ul></div>`;
                }

                // Handle \makecell ... (omitted standard logic for brevity, assuming standard processing)
                // ... (For simplicity, we assume innerContent is mostly the tabular now)

                let tableHtml = '';
                // Locate tabular
                const beginRegex = /\\begin\{tabular(\*?)\}/g;
                const beginMatch = beginRegex.exec(innerContent);
                let tabularRegion = { start: 0, end: 0 };

                if (beginMatch) {
                    const isStar = beginMatch[1] === '*';
                    let contentStartIndex = beginMatch.index + beginMatch[0].length;
                    // ... (Arg parsing logic same as before) ...
                    const requiredArgs = isStar ? 2 : 1;
                    let argsFound = 0;
                    while (argsFound < requiredArgs) {
                        while (contentStartIndex < innerContent.length && /\s/.test(innerContent[contentStartIndex])) { contentStartIndex++; }
                        if (contentStartIndex >= innerContent.length) { break; }
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
                        tabularRegion = { start: beginMatch.index, end: endMatch.index + endMatch[0].length };
                        let rawContent = innerContent.substring(contentStartIndex, endMatch.index);

                        // Clean raw tabular commands
                        rawContent = rawContent.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: string, c: string) => renderMath(c.trim(), false, renderer));
                        rawContent = rawContent.replace(/\\(toprule|midrule|bottomrule|hline|centering|raggedright|raggedleft)/g, '');
                        rawContent = rawContent.replace(/\\cmidrule(?:\[.*?\])?(?:\(.*?\))?\{[^}]+\}/g, '');
                        rawContent = rawContent.replace(/\\cline\{[^}]+\}/g, '');
                        rawContent = rawContent.replace(/\\vspace\*?\{[^}]+\}/g, '');
                        rawContent = rawContent.replace(/\\setlength\\[a-zA-Z]+\{[^}]+\}/g, '');

                        // Simple row/cell parsing
                        const rows = rawContent.split(/\\\\(?:\[.*?\])?/).filter((r: string) => r.trim().length > 0).map((rowText: string) => {
                            const cells = rowText.split('&').map((c: string) => {
                                let cellContent = c.trim();
                                let cellAttrs = 'style="padding: 5px 10px; border: 1px solid #ddd;"';
                                // ... (multicolumn/multirow logic) ...
                                cellContent = resolveLatexStyles(cellContent);
                                return `<td ${cellAttrs}>${renderer.renderInline(cellContent)}</td>`;
                            });
                            return `<tr>${cells.join('')}</tr>`;
                        }).join('');

                        tableHtml = `<table style="border-collapse: collapse; margin: 0 auto; width: 100%;">${rows}</table>`;
                    }
                }

                // 3. [FIX] Recover labels from text OUTSIDE the tabular
                let ignoredContent = innerContent.substring(0, tabularRegion.start) + innerContent.substring(tabularRegion.end);
                const hiddenLabels = recoverPreservedTokens(ignoredContent);

                return `\n\n` + renderer.protect('tbl', `<div class="latex-block table">${captionHtml}<div class="table-body">${tableHtml}</div>${notesHtml}${hiddenLabels}</div>`) + `\n\n`;
            });
        }
    },

    // --- Step 7: Theorem and proof environments ---
    {
        name: 'theorems_and_proofs',
        priority: 150,
        apply: (text, renderer: SmartRenderer) => {
            const thmRegex = new RegExp(`\\\\begin\\{(${REGEX_STR.THEOREM_ENVS})\\}(?:\\{.*?\\})?(?:\\[(.*?)\\])?([\\s\\S]*?)\\\\end\\{\\1\\}`, 'gi');

            text = text.replace(thmRegex, (match, envName, optArg, content) => {
                const displayName = capitalizeFirstLetter(envName);
                let header = `\n<span class="latex-thm-head"><strong class="latex-theorem-header">${displayName} <span class="sn-cnt" data-type="thm"></span>`;

                if (optArg) {
                    header += `</strong>&nbsp;(${optArg}).</span>&nbsp; `;
                } else {
                    header += `.</strong></span>&nbsp; `;
                }
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
                if (renderer.currentTitle) { titleBlock += `<h1 class="latex-title">${renderer.currentTitle}</h1>`; }
                if (renderer.currentAuthor) { titleBlock += `<div class="latex-author">${renderer.currentAuthor.replace(/\\\\/g, '<br/>')}</div>`; }
                if (renderer.currentDate) { titleBlock += `<div class="latex-date">${renderer.currentDate.replace(/\\\\/g, '<br/>')}</div>`; }
                text = text.replace(/\\maketitle.*/g, `\n\n` + renderer.protect('meta', titleBlock) + `\n\n`);
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
            const sectionRegex = new RegExp(`\\\\(${REGEX_STR.SECTION_LEVELS})(\\*?)\\{((?:[^{}]|{[^{}]*})*)\\}\\s*(\\\\label\\{[^}]+\\})?\\s*`, 'g');

            return text.replace(sectionRegex, (match, level, star, content, label) => {
                let prefix = '##';
                if (level === 'subsection') { prefix = '###'; }
                else if (level === 'subsubsection') { prefix = '####'; }
                else if (level === 'paragraph') { prefix = '#####'; }
                else if (level === 'subparagraph') { prefix = '######'; }

                let numHtml = "";
                if (star !== '*' && !['paragraph', 'subparagraph'].includes(level)) {
                    numHtml = `<span class="sn-cnt" data-type="sec"></span>. `;
                }

                let anchor = "";
                if (label) {
                    const labelName = label.match(/\{([^}]+)\}/)?.[1] || "";
                    anchor = `<span id="${labelName}" class="latex-label-anchor"></span>`;
                }
                if(anchor) {anchor = renderer.protect('anchor', anchor);}
                if(numHtml) {numHtml = renderer.protect('secnum', numHtml);}

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