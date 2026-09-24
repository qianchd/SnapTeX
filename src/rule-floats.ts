import { PreprocessRule, RenderContext } from './types';
import { SUBCAPTIONBOX_ARGUMENT_ORDER, SUBFIGURE_MACRO_COMMANDS } from './patterns';
import { extractAndHideLabels, replaceLatexCommandCalls, resolveLatexStyles } from './utils';
import { createStyleHtmlProtector, recoverPreservedTokens, renderCaptionContent, renderCaptionHtml, renderIncludeGraphicsHtml, renderNumberedCaptionPrefix, renderSubfigureHtml } from './rule-helpers';
import { findFirstTabularEnvironment, renderLatexTabular, renderLatexTableInlineContent } from './latex-table';
import { isAlgorithm2eSource, renderAlgorithm2eList, renderAlgorithmicList } from './latex-algorithm';

function replaceFloatEnvironment(text: string, envName: 'figure' | 'algorithm' | 'table', render: (content: string) => string): string {
    const pattern = new RegExp(`\\\\begin\\{${envName}(\\*?)\\}(?:\\[.*?\\])?([\\s\\S]*?)\\\\end\\{${envName}\\1\\}`, 'gi');
    return text.replace(pattern, (_match, _star, content) => render(content));
}

function renderIncludeGraphics(content: string, renderer: RenderContext): string {
    return replaceLatexCommandCalls(content, {
        name: 'includegraphics',
        allowStar: true,
        optionalArgs: 1,
        requiredArgs: 1,
        render: call => renderer.protectHtml('image', renderIncludeGraphicsHtml(call.requiredArgs[0].content), 'inline')
    });
}

function extractRenderedCaptions(content: string, renderer: RenderContext, className: string, prefixHtml = ''): { content: string; captionHtml: string } {
    let captionHtml = '';
    content = replaceLatexCommandCalls(content, {
        name: 'caption',
        allowStar: true,
        optionalArgs: 1,
        requiredArgs: 1,
        render: call => {
            captionHtml += renderCaptionHtml(
                className,
                renderCaptionContent(call.requiredArgs[0].content, renderer),
                call.star ? '' : prefixHtml
            );
            return '';
        }
    });
    return { content, captionHtml };
}

function cleanFigureLayoutCommands(content: string): string {
    return content
        .replace(/\\centering\b/g, '')
        .replace(/\\hfill\b/g, '')
        .replace(/\\vspace\*?(?:\[[^\]]*\])?\s*\{[^{}]*\}/g, '');
}

function renderFigureBody(content: string, renderer: RenderContext): string {
    const styled = resolveLatexStyles(
        cleanFigureLayoutCommands(content).trim(),
        createStyleHtmlProtector(renderer),
        renderer.metadata?.colors
    );
    return renderer.renderInline(renderIncludeGraphics(styled, renderer));
}

function renderSubfigureEnvironment(widthSpec: string, content: string, renderer: RenderContext): string {
    const { content: withoutCaption, captionHtml } = extractRenderedCaptions(content, renderer, 'subfigure-caption', '(<span class="sn-cnt" data-type="subfig"></span>) ');
    const { cleanContent, hiddenHtml } = extractAndHideLabels(withoutCaption);
    const body = renderFigureBody(cleanContent, renderer);
    return renderer.protectHtml('subfig', renderSubfigureHtml(body, captionHtml, widthSpec, hiddenHtml));
}

function renderSubfigureEnvironments(content: string, renderer: RenderContext): string {
    return content.replace(
        /\\begin\{subfigure\*?\}(?:\[[^\]]*\])?(?:\s*\{([^{}]*)\})?([\s\S]*?)\\end\{subfigure\*?\}/gi,
        (_match, widthSpec: string | undefined, subfigureContent: string) => renderSubfigureEnvironment(widthSpec ?? '', subfigureContent, renderer)
    );
}

function renderSubfigureMacro(widthSpec: string, caption: string, body: string, renderer: RenderContext): string {
    const captionParts = extractAndHideLabels(caption);
    const bodyParts = extractAndHideLabels(body);
    const bodyHtml = renderFigureBody(bodyParts.cleanContent, renderer);
    const captionHtml = captionParts.cleanContent.trim()
        ? renderCaptionHtml(
            'subfigure-caption',
            renderCaptionContent(captionParts.cleanContent, renderer),
            '(<span class="sn-cnt" data-type="subfig"></span>) '
        )
        : '';
    return renderer.protectHtml('subfig', renderSubfigureHtml(bodyHtml, captionHtml, widthSpec, captionParts.hiddenHtml + bodyParts.hiddenHtml));
}

function renderSubfigureMacros(content: string, renderer: RenderContext): string {
    return replaceLatexCommandCalls(content, [
        {
            name: SUBFIGURE_MACRO_COMMANDS,
            optionalArgs: 1,
            requiredArgs: 1,
            render: call => renderSubfigureMacro(
                '0.48\\textwidth',
                call.optionalArgs[0]?.content ?? '',
                call.requiredArgs[0].content,
                renderer
            )
        },
        {
            name: 'subcaptionbox',
            argumentOrder: SUBCAPTIONBOX_ARGUMENT_ORDER,
            render: call => renderSubfigureMacro(
                call.optionalArgs[0]?.content ?? '0.48\\textwidth',
                call.requiredArgs[0].content,
                call.requiredArgs[1].content,
                renderer
            )
        }
    ]);
}

/**
 * Converts LaTeX figure environments to protected HTML, preserving captions,
 * labels, local images, PDF canvases, and nested protected TikZ content.
 */
export function createFigureRule(): PreprocessRule {
    return {
        priority: 120,
        apply: (text: string, renderer: RenderContext) => {
            text = replaceFloatEnvironment(text, 'figure', content => {
                const hasSubfigures = /\\begin\{subfigure\*?\}|\\(?:subfloat|subfigure|subcaptionbox)\b/.test(content);
                const withSubfigures = renderSubfigureMacros(renderSubfigureEnvironments(content, renderer), renderer);
                const { content: extractedContent, captionHtml } = extractRenderedCaptions(withSubfigures, renderer, 'figure-caption', renderNumberedCaptionPrefix('Figure', 'fig'));
                const { cleanContent, hiddenHtml } = extractAndHideLabels(extractedContent);
                let body = renderFigureBody(cleanContent, renderer);
                if (hasSubfigures) {
                    body = `<div class="latex-subfigure-grid">${body}</div>`;
                }

                const finalHtml = `<div class="latex-figure" style="text-align: center; margin: 1em 0;">${body}${captionHtml}${hiddenHtml}</div>`;
                return `\n\n${renderer.protectHtml('fig', finalHtml)}\n\n`;
            });
            text = replaceLatexCommandCalls(text, {
                name: 'captionof',
                optionalArgs: 1,
                requiredArgs: 2,
                render: call => {
                    const type = call.requiredArgs[0].content.trim().toLowerCase();
                    const knownType = type === 'table' ? 'table' : type === 'figure' ? 'figure' : undefined;
                    return renderer.protectHtml('caption', renderCaptionHtml(
                        knownType ? `${knownType}-caption` : 'latex-caption',
                        renderCaptionContent(call.requiredArgs[1].content, renderer),
                        knownType ? renderNumberedCaptionPrefix(knownType === 'table' ? 'Table' : 'Figure', knownType === 'table' ? 'tbl' : 'fig') : ''
                    ));
                }
            });
            return replaceLatexCommandCalls(text, {
                name: 'includegraphics',
                allowStar: true,
                optionalArgs: 1,
                requiredArgs: 1,
                render: call => renderer.protectHtml('image', renderIncludeGraphicsHtml(call.requiredArgs[0].content))
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
        priority: 130,
        apply: (text: string, renderer: RenderContext) => {
            return replaceFloatEnvironment(text, 'algorithm', content => {
                const { content: extractedContent, captionHtml } = extractRenderedCaptions(content, renderer, 'alg-caption', renderNumberedCaptionPrefix('Algorithm', 'alg'));
                content = extractedContent;

                const algRegex = /\\begin\{algorithmic\}(?:\[(.*?)\])?([\s\S]*?)\\end\{algorithmic\}/g;
                let bodyHtml = '';
                const ignoredContent = content.replace(algRegex, (_match, params: string = '', rawBody: string) => {
                    bodyHtml += renderAlgorithmicList(rawBody, params.includes('1'), source => {
                        return renderer.renderInline(resolveLatexStyles(source, createStyleHtmlProtector(renderer), renderer.metadata?.colors));
                    }, renderer.metadata?.macros);
                    return '';
                });

                const rendersWholeBody = !bodyHtml && isAlgorithm2eSource(ignoredContent);
                if (rendersWholeBody) {
                    bodyHtml = renderAlgorithm2eList(ignoredContent, source => {
                        return renderer.renderInline(resolveLatexStyles(source, createStyleHtmlProtector(renderer), renderer.metadata?.colors));
                    });
                }
                const hiddenLabels = rendersWholeBody ? '' : recoverPreservedTokens(ignoredContent);
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
        priority: 118,
        apply: (text: string, renderer: RenderContext) => {
            text = replaceFloatEnvironment(text, 'table', content => {
                const { content: extractedContent, captionHtml } = extractRenderedCaptions(content, renderer, 'table-caption', renderNumberedCaptionPrefix('Table', 'tbl'));
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

            let tabular;
            while ((tabular = findFirstTabularEnvironment(text))) {
                let content = text.substring(tabular.bodyStart, tabular.bodyEnd);
                const caption = tabular.envName === 'longtable'
                    ? extractRenderedCaptions(content, renderer, 'table-caption', renderNumberedCaptionPrefix('Table', 'tbl'))
                    : { content, captionHtml: '' };
                content = caption.content;
                const tableHtml = renderLatexTabular(content, renderer);
                const replacement = `\n\n${renderer.protectHtml('tbl', `<div class="latex-table">${caption.captionHtml}<div class="table-body">${tableHtml}</div></div>`)}\n\n`;
                text = text.substring(0, tabular.beginStart) + replacement + text.substring(tabular.end);
            }
            return text;
        }
    };
}
