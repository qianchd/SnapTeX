import { PreprocessRule, RenderContext } from './types';
import { escapeHtmlAttribute, extractAndHideLabels, findCommand, resolveLatexStyles } from './utils';
import { createStyleHtmlProtector, recoverPreservedTokens, renderCaptionContent, renderSubfigureWidthStyle, unwrapResizeboxAroundProtectedContent } from './rule-helpers';
import { findFirstTabularEnvironment, renderLatexTabular, renderLatexTableInlineContent } from './latex-table';
import { renderAlgorithmicList } from './latex-algorithm';

interface FloatCaptionConfig {
    className: string;
    label: string;
    counterType: 'fig' | 'alg' | 'tbl';
}

function replaceFloatEnvironment(text: string, envName: 'figure' | 'algorithm' | 'table', render: (content: string) => string): string {
    const pattern = new RegExp(`\\\\begin\\{${envName}(\\*?)\\}(?:\\[.*?\\])?([\\s\\S]*?)\\\\end\\{${envName}\\1\\}`, 'gi');
    return text.replace(pattern, (_match, _star, content) => render(content));
}

export function renderIncludeGraphicsHtml(imgPath: string): string {
    const cleanPath = imgPath.trim();
    const safePath = escapeHtmlAttribute(cleanPath);
    const canvasId = `pdf-${Math.random().toString(36).substr(2, 9)}`;

    if (cleanPath.toLowerCase().endsWith('.pdf')) {
        return `<canvas id="${canvasId}" data-req-path="${safePath}" style="width:100%; max-width:100%; display:block; margin:0 auto;"></canvas>`;
    }
    return `<img src="LOCAL_IMG:${safePath}" style="max-width:100%; display:block; margin:0 auto;">`;
}

function extractRenderedCaption(content: string, renderer: RenderContext, config: FloatCaptionConfig): { content: string; captionHtml: string } {
    const captionRes = findCommand(content, 'caption');
    if (!captionRes) {
        return { content, captionHtml: '' };
    }

    const captionHtml = `<div class="${config.className}"><strong>${config.label} <span class="sn-cnt" data-type="${config.counterType}"></span>:</strong> ${renderCaptionContent(captionRes.content, renderer)}</div>`;
    return {
        content: content.substring(0, captionRes.start) + content.substring(captionRes.end),
        captionHtml
    };
}

function extractRenderedPlainCaption(content: string, renderer: RenderContext, className: string, prefixHtml = ''): { content: string; captionHtml: string } {
    const captionRes = findCommand(content, 'caption');
    if (!captionRes) {
        return { content, captionHtml: '' };
    }

    return {
        content: content.substring(0, captionRes.start) + content.substring(captionRes.end),
        captionHtml: `<div class="${className}">${prefixHtml}${renderCaptionContent(captionRes.content, renderer)}</div>`
    };
}

function cleanFigureLayoutCommands(content: string): string {
    return content
        .replace(/\\centering\b/g, '')
        .replace(/\\hfill\b/g, '')
        .replace(/\\vspace\*?(?:\[[^\]]*\])?\s*\{[^{}]*\}/g, '');
}

function renderSubfigureEnvironment(widthSpec: string, content: string, renderer: RenderContext): string {
    const { content: withoutCaption, captionHtml } = extractRenderedPlainCaption(content, renderer, 'subfigure-caption', '(<span class="sn-cnt" data-type="subfig"></span>) ');
    const { cleanContent, hiddenHtml } = extractAndHideLabels(withoutCaption);
    let body = cleanFigureLayoutCommands(cleanContent).trim();
    body = unwrapResizeboxAroundProtectedContent(body);
    body = body.replace(/\\includegraphics(?:\[.*?\])?\s*\{([^}]+)\}/g, (_imgMatch: string, imgPath: string) => renderIncludeGraphicsHtml(imgPath));
    return `<div class="latex-subfigure" style="${renderSubfigureWidthStyle(widthSpec)}">${body}${captionHtml}${hiddenHtml}</div>`;
}

function renderSubfigureEnvironments(content: string, renderer: RenderContext): string {
    return content.replace(
        /\\begin\{subfigure\*?\}(?:\[[^\]]*\])?\s*\{([^{}]*)\}([\s\S]*?)\\end\{subfigure\*?\}/gi,
        (_match, widthSpec: string, subfigureContent: string) => renderSubfigureEnvironment(widthSpec, subfigureContent, renderer)
    );
}

/**
 * Converts LaTeX figure environments to protected HTML, preserving captions,
 * labels, local images, PDF canvases, and nested protected TikZ content.
 */
export function createFigureRule(): PreprocessRule {
    return {
        name: 'figure',
        priority: 120,
        apply: (text: string, renderer: RenderContext) => {
            return replaceFloatEnvironment(text, 'figure', content => {
                const withSubfigures = renderSubfigureEnvironments(content, renderer);
                const hasSubfigures = withSubfigures.includes('class="latex-subfigure"');
                const { content: extractedContent, captionHtml } = extractRenderedCaption(withSubfigures, renderer, { className: 'figure-caption', label: 'Figure', counterType: 'fig' });
                let body = extractedContent;

                const { cleanContent, hiddenHtml } = extractAndHideLabels(body);
                body = cleanContent;

                body = cleanFigureLayoutCommands(body).trim();
                body = unwrapResizeboxAroundProtectedContent(body);

                body = body.replace(/\\includegraphics(?:\[.*?\])?\s*\{([^}]+)\}/g, (_imgMatch: string, imgPath: string) => renderIncludeGraphicsHtml(imgPath));
                if (hasSubfigures) {
                    body = `<div class="latex-subfigure-grid">${body}</div>`;
                }

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
            return replaceFloatEnvironment(text, 'algorithm', content => {
                const { content: extractedContent, captionHtml } = extractRenderedCaption(content, renderer, { className: 'alg-caption', label: 'Algorithm', counterType: 'alg' });
                content = extractedContent;

                const algRegex = /\\begin\{algorithmic\}(?:\[(.*?)\])?([\s\S]*?)\\end\{algorithmic\}/g;
                let bodyHtml = '';
                let matchAlg;
                const processedRegions: {start: number, end: number}[] = [];

                while ((matchAlg = algRegex.exec(content)) !== null) {
                    processedRegions.push({start: matchAlg.index, end: matchAlg.index + matchAlg[0].length});
                    const params = matchAlg[1] || '';
                    const rawBody = matchAlg[2];
                    bodyHtml += renderAlgorithmicList(rawBody, params.includes('1'), source => {
                        return renderer.renderInline(resolveLatexStyles(source, createStyleHtmlProtector(renderer)));
                    });
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
        priority: 118,
        apply: (text: string, renderer: RenderContext) => {
            return replaceFloatEnvironment(text, 'table', content => {
                const { content: extractedContent, captionHtml } = extractRenderedCaption(content, renderer, { className: 'table-caption', label: 'Table', counterType: 'tbl' });
                content = extractedContent;

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
                            labelHtml = `<strong>${renderLatexTableInlineContent(lblMatch[1], renderer)}</strong> `;
                            itemText = item.substring(lblMatch[0].length);
                        }
                        return `<li class="note-item" style="list-style:none">${labelHtml}${renderLatexTableInlineContent(itemText.trim(), renderer)}</li>`;
                    }).join('');
                    notesHtml = `<div class="latex-tablenotes"><ul>${noteItems}</ul></div>`;
                }

                let tableHtml = '';
                let tabularRegion = { start: 0, end: 0 };
                const tabular = findFirstTabularEnvironment(innerContent);

                if (tabular) {
                    tabularRegion = { start: tabular.beginStart, end: tabular.end };
                    const rawContent = innerContent.substring(tabular.bodyStart, tabular.bodyEnd);
                    tableHtml = renderLatexTabular(rawContent, renderer);
                }

                const ignoredContent = innerContent.substring(0, tabularRegion.start) + innerContent.substring(tabularRegion.end);
                const hiddenLabels = recoverPreservedTokens(ignoredContent);

                return `\n\n${renderer.protectHtml('tbl', `<div class="latex-table">${captionHtml}<div class="table-body">${tableHtml}</div>${notesHtml}${hiddenLabels}</div>`)}\n\n`;
            });
        }
    };
}
