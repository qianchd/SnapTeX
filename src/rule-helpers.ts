import katex from 'katex';
import { RenderContext } from './types';
import { escapeHtmlAttribute, resolveLatexStyles } from './utils';

/**
 * Renders TeX math through KaTeX and protects the generated HTML from Markdown.
 */
export function renderMath(tex: string, displayMode: boolean, renderer: RenderContext): string {
    try {
        const html = katex.renderToString(tex, {
            displayMode: displayMode,
            macros: renderer.currentMacros,
            throwOnError: false,
            errorColor: '#cc0000',
            globalGroup: true,
            trust: false
        });
        return renderer.protectHtml('math', html);
    } catch (e) {
        return renderer.protectHtml('math', `<span style="color:red">Math Error</span>`);
    }
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

export function protectInlineStyle(renderer: RenderContext): (html: string) => string {
    return html => renderer.protectHtml('style', html, 'inline');
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
    return renderer.renderInline(resolveLatexStyles(withMath, protectInlineStyle(renderer)));
}

export function unwrapResizeboxAroundProtectedContent(text: string): string {
    return text.replace(
        /\\resizebox\s*\{[^{}]*\}\s*\{[^{}]*\}\s*\{\s*((?:XSNAP:[a-zA-Z0-9_-]+:\d+Y\s*)+)\}/g,
        (_match, protectedContent: string) => protectedContent.trim()
    );
}
