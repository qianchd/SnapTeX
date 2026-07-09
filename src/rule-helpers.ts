import katex from 'katex';
import { BibTexParser } from './bib';
import type { AffiliationMetadata, AuthorMetadata, BibEntry, RenderContext } from './types';
import {
    escapeHtml,
    escapeHtmlAttribute,
    replaceLatexCommandCalls,
    resolveLatexStyles,
    resolveLatexTextTransforms,
    sanitizeHttpUrlForAttribute
} from './utils';

const BLOCK_LEVEL_HTML_PATTERN = /<(?:div|section|article|table|ul|ol|li|h[1-6]|p|blockquote|pre|canvas|script)\b|class="katex-display"/i;

export function hasBlockLevelHtml(html: string): boolean {
    return BLOCK_LEVEL_HTML_PATTERN.test(html);
}

export function renderKatexHtml(tex: string, displayMode: boolean, macros: Record<string, string>): string {
    try {
        return katex.renderToString(tex, {
            displayMode,
            macros,
            throwOnError: false,
            errorColor: '#cc0000',
            globalGroup: true,
            trust: false
        });
    } catch {
        return '<span style="color:red">Math Error</span>';
    }
}

/**
 * Renders TeX math through KaTeX and protects the generated HTML from Markdown.
 */
export function renderMath(tex: string, displayMode: boolean, renderer: RenderContext): string {
    return renderer.protectHtml('math', renderKatexHtml(tex, displayMode, renderer.currentMacros));
}

export function renderInlineLatexHtml(
    text: string | undefined,
    renderMathHtml: (tex: string) => string
): string {
    if (!text) { return ''; }

    const htmlFragments: string[] = [];
    const protectHtml = (html: string) => {
        const token = `\uE000SNAP_INLINE_HTML_${htmlFragments.length}\uE001`;
        htmlFragments.push(html);
        return token;
    };

    const lineBreak = protectHtml('<br/>');
    let rendered = replaceLatexCommandCalls(resolveLatexTextTransforms(text), {
        name: 'footnote',
        requiredArgs: 1,
        render: () => ''
    });
    rendered = rendered
        .replace(/<br\s*\/?>/gi, lineBreak)
        .replace(/\\(?:and|And)\b/g, lineBreak)
        .replace(/\\\\/g, lineBreak)
        .replace(/\$((?:\\.|[^\\$])*)\$/g, (_match, content: string) => protectHtml(renderMathHtml(content.trim())));
    rendered = resolveLatexStyles(rendered, html => protectHtml(html));

    return escapeHtml(rendered)
        .replace(/\uE000SNAP_INLINE_HTML_(\d+)\uE001/g, (_match, index: string) => htmlFragments[Number(index)] ?? '')
        .replace(/~/g, '&nbsp;');
}

export function renderNumberedEquationHtml(mathHtml: string, numberHtml: string, trailingHtml = ''): string {
    return `<div class="equation-container" style="position: relative; width: 100%;">
${mathHtml}
<span class="eq-no" style="position: absolute; right: 0; top: 50%; transform: translateY(-50%); pointer-events: none;">${numberHtml}</span>
</div>${trailingHtml}`;
}

/**
 * Creates a protected reference placeholder that scanner numbering fills later.
 */
export function createRefLink(key: string, renderer: RenderContext, type: 'ref' | 'eqref' = 'ref'): string {
    const safeKey = escapeHtmlAttribute(key);
    const html = `<a href="#${safeKey}" class="sn-ref" data-key="${safeKey}" style="color:inherit; text-decoration:none;">?</a>`;
    const token = renderer.protectHtml('ref', html);
    if (type === 'eqref') {
        return `(\\text{${token}})`;
    }
    return `\\text{${token}}`;
}

export function renderReferenceLinksHtml(labels: readonly string[], type: 'ref' | 'eqref' = 'ref'): string {
    const links = labels
        .map(label => label.trim())
        .filter(Boolean)
        .map(label => {
            const safeLabel = escapeHtmlAttribute(label);
            return `<a href="#${safeLabel}" class="latex-link latex-ref sn-ref" data-key="${safeLabel}">?</a>`;
        })
        .join(', ');
    return type === 'eqref' ? `(${links})` : links;
}

export function renderMaketitleAuthorsHtml(
    authors: readonly AuthorMetadata[],
    affiliations: readonly AffiliationMetadata[],
    renderValue: (value: string | undefined) => string
): string {
    if (authors.length === 0) { return ''; }

    const isPlainAuthorBlock = authors.length === 1
        && authors[0].emails.length === 0
        && authors[0].affiliationIds.length === 0
        && affiliations.length === 0;
    if (isPlainAuthorBlock) {
        return `<div class="latex-author">${renderValue(authors[0].name)}</div>`;
    }

    const labelById = new Map(affiliations.map((affiliation, index) => [affiliation.id, String(index + 1)]));
    const authorItems = authors.map(author => {
        const labels = author.affiliationIds.map(id => labelById.get(id) ?? id).filter(Boolean);
        const marker = labels.length > 0 ? `<sup>${escapeHtml(labels.join(','))}</sup>` : '';
        const emailHtml = author.emails.length > 0
            ? `<span class="latex-author-email">${author.emails.map(email => renderValue(email)).join(', ')}</span>`
            : '';
        return `<span class="latex-author-item">${renderValue(author.name)}${marker}${emailHtml}</span>`;
    }).join('');
    const affiliationHtml = affiliations.length > 0
        ? `<div class="latex-affiliations">${affiliations.map((affiliation, index) => `<div><sup>${index + 1}</sup> ${renderValue(affiliation.text)}</div>`).join('')}</div>`
        : '';
    return `<div class="latex-author">${authorItems}</div>${affiliationHtml}`;
}

export function renderBibliographyItemsHtml(
    items: Array<{ key: string; entry?: BibEntry }>,
    renderer: Pick<RenderContext, 'protectHtml'>
): string {
    const body = items.map(({ key, entry }) => {
        const safeKey = escapeHtmlAttribute(key);
        const content = entry
            ? BibTexParser.formatEntry(entry, renderer)
            : `<span style="color:red">Bib entry '${escapeHtml(key)}' not found.</span>`;
        return `<div class="bib-item" id="ref-${safeKey}" style="margin-bottom: 0.8em; padding-left: 2em; text-indent: -2em;">${content}</div>`;
    }).join('');
    return `<h2 class="latex-bibliography-header">References</h2><div class="latex-bibliography-list">${body}</div>`;
}

export function renderExternalLinkHtml(rawUrl: string, contentHtml: string, className: string): string | undefined {
    const safeHref = sanitizeHttpUrlForAttribute(rawUrl);
    return safeHref
        ? `<a href="${safeHref}" class="latex-link ${className}" target="_blank" rel="noopener noreferrer">${contentHtml}</a>`
        : undefined;
}

export function createStyleHtmlProtector(renderer: RenderContext): (html: string, mode?: Parameters<RenderContext['protectHtml']>[2]) => string {
    return (html, mode = 'inline') => renderer.protectHtml('style', html, mode);
}

/**
 * Recovers protection tokens that were embedded in ignored float regions.
 */
export function recoverPreservedTokens(text: string): string {
    const tokenRegex = /XSNAP:[a-zA-Z0-9_-]+:\d+Y/g;
    let found = "";
    let match;
    while ((match = tokenRegex.exec(text)) !== null) {
        found += match[0];
    }
    return found;
}

export function renderCaptionContent(captionText: string, renderer: RenderContext): string {
    const withMath = captionText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (_match: string, content: string) => {
        return renderMath(content.trim(), false, renderer);
    });
    return renderer.renderInline(resolveLatexStyles(withMath, createStyleHtmlProtector(renderer)));
}

export function unwrapResizeboxAroundProtectedContent(text: string): string {
    return text.replace(
        /\\resizebox\s*\{[^{}]*\}\s*\{[^{}]*\}\s*\{\s*((?:XSNAP:[a-zA-Z0-9_-]+:\d+Y\s*)+)\}/g,
        (_match, protectedContent: string) => protectedContent.trim()
    );
}
