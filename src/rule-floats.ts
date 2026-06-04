import { PreprocessRule, RenderContext } from './types';
import { escapeHtmlAttribute, extractAndHideLabels, findBalancedClosingBrace, findCommand, resolveLatexStyles } from './utils';
import { recoverPreservedTokens, renderCaptionContent, renderMath, unwrapResizeboxAroundProtectedContent } from './rule-helpers';

/**
 * Converts LaTeX figure environments to protected HTML, preserving captions,
 * labels, local images, PDF canvases, and nested protected TikZ content.
 */
export function createFigureRule(): PreprocessRule {
    return {
        name: 'figure',
        priority: 120,
        apply: (text: string, renderer: RenderContext) => {
            return text.replace(/\\begin\{figure(\*?)\}(?:\[.*?\])?([\s\S]*?)\\end\{figure\1\}/gi, (_match, star, content) => {
                const captionRes = findCommand(content, 'caption');
                let captionHtml = '';
                let body = content;

                if (captionRes) {
                    captionHtml = `<div class="figure-caption"><strong>Figure <span class="sn-cnt" data-type="fig"></span>:</strong> ${renderCaptionContent(captionRes.content, renderer)}</div>`;
                    body = body.substring(0, captionRes.start) + body.substring(captionRes.end + 1);
                }

                const { cleanContent, hiddenHtml } = extractAndHideLabels(body);
                body = cleanContent;

                body = body.trim().replace(/\\centering/g, '');
                body = unwrapResizeboxAroundProtectedContent(body);

                body = body.replace(/\\includegraphics(?:\[.*?\])?\s*\{([^}]+)\}/g, (_imgMatch: string, imgPath: string) => {
                    const cleanPath = imgPath.trim();
                    const safePath = escapeHtmlAttribute(cleanPath);
                    const canvasId = `pdf-${Math.random().toString(36).substr(2, 9)}`;

                    if (cleanPath.toLowerCase().endsWith('.pdf')) {
                        return `<canvas id="${canvasId}" data-req-path="${safePath}" style="width:100%; max-width:100%; display:block; margin:0 auto;"></canvas>`;
                    }
                    return `<img src="LOCAL_IMG:${safePath}" style="max-width:100%; display:block; margin:0 auto;">`;
                });

                const finalHtml = `<div class="latex-figure" style="text-align: center; margin: 1em 0;">${body}${captionHtml}${hiddenHtml}</div>`;
                return `\n\n${renderer.protectHtml('fig', finalHtml)}\n\n`;
            });
        }
    };
}

/**
 * Converts algorithm/algorithmic environments into compact ordered or unordered
 * HTML lists while preserving captions and labels.
 */
export function createAlgorithmRule(): PreprocessRule {
    return {
        name: 'algorithm',
        priority: 130,
        apply: (text: string, renderer: RenderContext) => {
            return text.replace(/\\begin\{algorithm(\*?)\}(?:\[.*?\])?([\s\S]*?)\\end\{algorithm\1\}/gi, (_match, star, content) => {
                const captionRes = findCommand(content, 'caption');
                let captionHtml = '';
                if (captionRes) {
                    captionHtml = `<div class="alg-caption"><strong>Algorithm <span class="sn-cnt" data-type="alg"></span>:</strong> ${renderCaptionContent(captionRes.content, renderer)}</div>`;
                    content = content.substring(0, captionRes.start) + content.substring(captionRes.end + 1);
                }

                const algRegex = /\\begin\{algorithmic\}(?:\[(.*?)\])?([\s\S]*?)\\end\{algorithmic\}/g;
                let bodyHtml = '';
                let matchAlg;
                const processedRegions: {start: number, end: number}[] = [];

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
                            if (contentToRender.startsWith('{') && contentToRender.endsWith('}')) {
                                contentToRender = contentToRender.substring(1, contentToRender.length - 1);
                            }
                        }

                        contentToRender = resolveLatexStyles(contentToRender, html => renderer.protectHtml('style', html));
                        const renderedContent = renderer.renderInline(contentToRender);
                        const itemClass = isSpecialLine ? "alg-item alg-item-no-marker" : "alg-item";
                        listItems += `<li class="${itemClass}">${prefixHtml}${renderedContent}</li>`;
                    });

                    bodyHtml += `<${listTag} class="alg-list">${listItems}</${listTag}>`;
                }

                let ignoredContent = "";
                let lastIdx = 0;
                processedRegions.forEach(reg => {
                    ignoredContent += content.substring(lastIdx, reg.start);
                    lastIdx = reg.end;
                });
                ignoredContent += content.substring(lastIdx);

                const hiddenLabels = recoverPreservedTokens(ignoredContent);
                return `\n\n${renderer.protectHtml('alg', `<div class="latex-algorithm">${captionHtml}${bodyHtml}${hiddenLabels}<div class="alg-bottom-rule"></div></div>`)}\n\n`;
            });
        }
    };
}

/**
 * Converts common table/tabular forms into preview HTML tables.
 */
export function createTableRule(): PreprocessRule {
    return {
        name: 'table',
        priority: 140,
        apply: (text: string, renderer: RenderContext) => {
            return text.replace(/\\begin\{table(\*?)\}(?:\[.*?\])?([\s\S]*?)\\end\{table\1\}/gi, (_match, star, content) => {
                const captionRes = findCommand(content, 'caption');
                let captionHtml = '';

                if (captionRes) {
                    captionHtml = `<div class="table-caption"><strong>Table <span class="sn-cnt" data-type="tbl"></span>:</strong> ${renderCaptionContent(captionRes.content, renderer)}</div>`;
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
                        itemText = itemText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (_m: string, c: string) => renderMath(c.trim(), false, renderer));
                        return `<li class="note-item" style="list-style:none">${labelHtml}${renderer.renderInline(itemText.trim())}</li>`;
                    }).join('');
                    notesHtml = `<div class="latex-tablenotes"><ul>${noteItems}</ul></div>`;
                }

                let tableHtml = '';
                const beginRegex = /\\begin\{(tabular\*?|tabularx)\}/g;
                const beginMatch = beginRegex.exec(innerContent);
                let tabularRegion = { start: 0, end: 0 };

                if (beginMatch) {
                    const envName = beginMatch[1];
                    let contentStartIndex = beginMatch.index + beginMatch[0].length;
                    const requiredArgs = envName === 'tabular' ? 1 : 2;
                    let argsFound = 0;
                    while (argsFound < requiredArgs) {
                        while (contentStartIndex < innerContent.length && /\s/.test(innerContent[contentStartIndex])) { contentStartIndex++; }
                        if (contentStartIndex >= innerContent.length) { break; }
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
                            } else {
                                break;
                            }
                        } else {
                            break;
                        }
                    }

                    const escapedEnvName = envName.replace(/\*/g, '\\*');
                    const endRegex = new RegExp(`\\\\end\\{${escapedEnvName}\\}`, 'g');
                    endRegex.lastIndex = contentStartIndex;
                    const endMatch = endRegex.exec(innerContent);

                    if (endMatch) {
                        tabularRegion = { start: beginMatch.index, end: endMatch.index + endMatch[0].length };
                        let rawContent = innerContent.substring(contentStartIndex, endMatch.index);

                        rawContent = rawContent.replace(/\$((?:\\.|[^\\$])+?)\$/g, (_m: string, c: string) => renderMath(c.trim(), false, renderer));
                        rawContent = rawContent.replace(/\\(toprule|midrule|bottomrule|hline|centering|raggedright|raggedleft)/g, '');
                        rawContent = rawContent.replace(/\\cmidrule(?:\[.*?\])?(?:\(.*?\))?\{[^}]+\}/g, '');
                        rawContent = rawContent.replace(/\\cline\{[^}]+\}/g, '');
                        rawContent = rawContent.replace(/\\vspace\*?\{[^}]+\}/g, '');
                        rawContent = rawContent.replace(/\\setlength\\[a-zA-Z]+\{[^}]+\}/g, '');

                        const rows = rawContent.split(/\\\\(?:\[.*?\])?/).filter((row: string) => row.trim().length > 0).map((rowText: string) => {
                            const cells = rowText.split('&').map((cell: string) => {
                                const cellAttrs = 'style="padding: 5px 10px; border: 1px solid #ddd;"';
                                const cellContent = resolveLatexStyles(cell.trim(), html => renderer.protectHtml('style', html));
                                return `<td ${cellAttrs}>${renderer.renderInline(cellContent)}</td>`;
                            });
                            return `<tr>${cells.join('')}</tr>`;
                        }).join('');

                        tableHtml = `<table style="border-collapse: collapse; margin: 0 auto; width: 100%;">${rows}</table>`;
                    }
                }

                const ignoredContent = innerContent.substring(0, tabularRegion.start) + innerContent.substring(tabularRegion.end);
                const hiddenLabels = recoverPreservedTokens(ignoredContent);

                return `\n\n${renderer.protectHtml('tbl', `<div class="latex-table">${captionHtml}<div class="table-body">${tableHtml}</div>${notesHtml}${hiddenLabels}</div>`)}\n\n`;
            });
        }
    };
}
