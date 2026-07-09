import { BibTexParser } from '../../bib';
import { renderBibliographyItemsHtml, renderExternalLinkHtml, renderMaketitleAuthorsHtml } from '../../rule-helpers';
import { toRoman } from '../../utils';
import { environmentName, isEnvironmentNode, isMacroNode, readRequiredMacroArgument } from '../visit-utils';
import type { AstRenderContext, AstRenderRule } from './index';
import { readAstCommandArguments, renderInlineLatexSource } from './index';

const ABSTRACT_MACROS = new Set(['Abstract', 'abstract']);
const KEYWORD_MACROS = new Set(['Keywords', 'keywords', 'Keyword', 'keyword']);
const LAYOUT_MACROS = new Set(['baselineskip', 'parskip', 'parindent', 'vspace', 'hspace', 'setlength', 'addtolength']);

const AST_BIB_RENDERER = { protectHtml: (_namespace: string, html: string) => html };

function renderBibliographyFromCitedKeys(context: AstRenderContext): string {
    const keys = Array.from(new Set(context.getCitedKeys())).sort((a, b) => {
        const entryA = context.bibEntries.get(a);
        const entryB = context.bibEntries.get(b);
        return (entryA?.fields.author || '').localeCompare(entryB?.fields.author || '');
    });
    return keys.length === 0
        ? '<div class="latex-bibliography error">No citations found.</div>'
        : renderBibliographyItemsHtml(keys.map(key => ({ key, entry: context.bibEntries.get(key) })), AST_BIB_RENDERER);
}

export const AST_MAKETITLE_RULE: AstRenderRule = {
    name: 'ast-maketitle',
    match: input => isMacroNode(input.node, 'maketitle'),
    render: (_input, context) => {
        const metadata = context.metadata;
        if (!metadata) {
            return { html: '' };
        }

        const parts = [
            metadata.title ? `<h1 class="latex-title">${renderInlineLatexSource(metadata.title, context)}</h1>` : '',
            renderMaketitleAuthorsHtml(metadata.authors, metadata.affiliations, value => renderInlineLatexSource(value ?? '', context)),
            metadata.custom.editor ? `<div class="latex-editor"><strong>Editor:</strong> ${renderInlineLatexSource(metadata.custom.editor, context)}</div>` : '',
            metadata.date ? `<div class="latex-date">${renderInlineLatexSource(metadata.date, context)}</div>` : ''
        ].filter(Boolean);
        return { html: parts.join('') };
    }
};

export const AST_ABSTRACT_KEYWORDS_RULE: AstRenderRule = {
    name: 'ast-abstract-keywords',
    match: input => {
        const envName = environmentName(input.node);
        return envName === 'abstract'
            || (isMacroNode(input.node) && (ABSTRACT_MACROS.has(input.node.content) || KEYWORD_MACROS.has(input.node.content)));
    },
    render: (input, context) => {
        if (isEnvironmentNode(input.node) && Array.isArray(input.node.content)) {
            return { html: `<div class="latex-abstract"><span class="latex-abstract-title">Abstract</span>${input.renderChildren(input.node.content)}</div>` };
        }

        if (!isMacroNode(input.node)) {
            return undefined;
        }

        const args = readAstCommandArguments(input);
        const content = args.requiredArgs[0] ?? '';
        if (ABSTRACT_MACROS.has(input.node.content)) {
            return {
                html: `<div class="latex-abstract"><span class="latex-abstract-title">Abstract</span>${renderInlineLatexSource(content, context)}</div>`,
                consumedNodes: args.consumedNodes
            };
        }
        return {
            html: `<div class="latex-keywords"><strong>Keywords:</strong> ${renderInlineLatexSource(content, context)}</div>`,
            consumedNodes: args.consumedNodes
        };
    }
};

export const AST_BIBLIOGRAPHY_RULE: AstRenderRule = {
    name: 'ast-bibliography',
    match: input => {
        const envName = environmentName(input.node);
        return envName === 'thebibliography' || isMacroNode(input.node, 'bibliography') || isMacroNode(input.node, 'bibliographystyle');
    },
    render: (input, context) => {
        if (isMacroNode(input.node, 'bibliographystyle')) {
            return { html: '' };
        }
        if (isEnvironmentNode(input.node) && Array.isArray(input.node.content)) {
            const entries = Array.from(BibTexParser.parseBibItems(context.sourceSlice(input.node)).values());
            return { html: entries.length > 0 ? renderBibliographyItemsHtml(entries.map(entry => ({ key: entry.key, entry })), AST_BIB_RENDERER) : '' };
        }
        return { html: renderBibliographyFromCitedKeys(context) };
    }
};

export const AST_LINK_RULE: AstRenderRule = {
    name: 'ast-link',
    match: input => isMacroNode(input.node) && ['href', 'url'].includes(input.node.content),
    render: (input, context) => {
        if (!isMacroNode(input.node)) {
            return undefined;
        }
        const args = readAstCommandArguments(input);
        const rawUrl = args.requiredArgs[0];
        const label = input.node.content === 'href' ? args.requiredArgs[1] : rawUrl;
        const content = renderInlineLatexSource(label ?? rawUrl, context);
        return {
            html: renderExternalLinkHtml(rawUrl, content, `latex-${input.node.content}`) ?? content,
            consumedNodes: args.consumedNodes
        };
    }
};

export const AST_COMMON_MACRO_RULE: AstRenderRule = {
    name: 'ast-common-macro',
    match: input => isMacroNode(input.node),
    render: (input, context) => {
        if (!isMacroNode(input.node)) {
            return undefined;
        }

        if (['centering', 'appendix', 'small', 'footnotesize', 'scriptsize', 'tiny'].includes(input.node.content)) {
            return { html: '' };
        }
        if (LAYOUT_MACROS.has(input.node.content)) {
            return { html: '', consumedNodes: readAstCommandArguments(input).consumedNodes };
        }
        if (input.node.content === 'noindent') {
            return { html: '<span class="no-indent-marker"></span>' };
        }
        if (input.node.content === 'mbox' || input.node.content === 'text') {
            const args = readAstCommandArguments(input);
            return {
                html: renderInlineLatexSource(args.requiredArgs[0] ?? '', context),
                consumedNodes: args.consumedNodes
            };
        }
        if (input.node.content === 'resizebox') {
            const content = readRequiredMacroArgument(input.node, 2)?.content;
            return content ? { html: input.renderChildren(content) } : undefined;
        }
        if (['Rmnum', 'rmnum', 'romannumeral'].includes(input.node.content)) {
            const args = readAstCommandArguments(input);
            const value = Number.parseInt(args.requiredArgs[0] ?? '', 10);
            return Number.isFinite(value)
                ? { html: context.escapeHtml(toRoman(value, input.node.content === 'Rmnum')), consumedNodes: args.consumedNodes }
                : undefined;
        }
        if (input.node.content === '\\') {
            return { html: '<br/>' };
        }
        if (['%', '#', '&', '$', '{', '}'].includes(input.node.content)) {
            return { html: context.escapeHtml(input.node.content) };
        }
        if (input.node.content === 'footnote') {
            return { html: '', consumedNodes: readAstCommandArguments(input).consumedNodes };
        }
        return undefined;
    }
};
