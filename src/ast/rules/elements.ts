import { BibTexParser } from '../../bib';
import { ACKNOWLEDGMENT_ENVS, QUOTE_ENVS } from '../../patterns';
import { latexRelativeWidthPercent, normalizeLatexKeywordSeparators, renderBibliographyItemsHtml, renderCitedBibliographyHtml, renderExternalLinkHtml, renderMaketitleAuthorsHtml } from '../../rule-helpers';
import { astNodesToLatex, astNodesToText, environmentName, isCommentNode, isEnvironmentNode, isMacroNode, readNodeArgument, splitLeadingBracketNodes, stringNodeContent } from '../visit-utils';
import { readAstCommandArguments, readAstCommandNodeArguments, renderInlineLatexSource, type AstRenderRule } from './index';

const ABSTRACT_MACROS = new Set(['Abstract', 'abstract']);
const KEYWORD_MACROS = new Set(['Keywords', 'keywords', 'Keyword', 'keyword']);
const KEYWORD_ENVIRONMENTS = new Set(['IEEEkeywords', 'keywords', 'keyword']);
const QUOTE_ENVIRONMENTS = new Set<string>(QUOTE_ENVS);
const ACKNOWLEDGMENT_ENVIRONMENTS = new Set<string>(ACKNOWLEDGMENT_ENVS);

const AST_BIB_RENDERER = { protectHtml: (_namespace: string, html: string) => html };

export const AST_COMMENT_BOUNDARY_RULE: AstRenderRule = input => {
    if (!isCommentNode(input.node)) {
        return undefined;
    }
    let previousIndex = input.index - 1;
    while (isCommentNode(input.siblings[previousIndex])) {
        previousIndex--;
    }
    const previous = input.siblings[previousIndex];
    const nextText = stringNodeContent(input.siblings[input.index + 1]);
    return { html: isMacroNode(previous) && /^[A-Za-z@]/.test(nextText ?? '') ? ' ' : '' };
};

export const AST_COMMENT_ENVIRONMENT_RULE: AstRenderRule = input =>
    environmentName(input.node) === 'comment' ? { html: '' } : undefined;

export const AST_DEFINED_ENVIRONMENT_RULE: AstRenderRule = (input, context) => {
    const envName = environmentName(input.node);
    const definition = envName ? context.metadata?.environments[envName] : undefined;
    if (isMacroNode(input.node) && (input.node.content === 'begin' || input.node.content === 'end')) {
        const args = readAstCommandArguments(input, 1);
        const boundaryName = args.requiredArgs[0]?.trim();
        return boundaryName && context.metadata?.environments[boundaryName]?.kind === 'transparent'
            ? { html: '', consumedNodes: args.consumedNodes }
            : undefined;
    }
    if (!isEnvironmentNode(input.node) || !definition || definition.kind === 'theorem' || !Array.isArray(input.node.content)) {
        return undefined;
    }

    if (definition.kind === 'transparent') {
        return { html: input.renderChildren(input.node.content) };
    }

    const body = context.sourceContent(input.node.content);
    if (definition.kind === 'style') {
        return { html: input.renderSource(`{${definition.declaration} ${body}}`) };
    }

    const opening = definition.opening
        ?? `\\begin{${definition.target}}${definition.options ? `[${definition.options}]` : ''}`;
    return { html: input.renderSource(`${opening}\n${body}\n${definition.closing ?? `\\end{${definition.target}}`}`) };
};

export const AST_CENTER_RULE: AstRenderRule = input =>
    isEnvironmentNode(input.node, 'center') && Array.isArray(input.node.content)
        ? { html: `<div class="latex-center">${input.renderChildren(input.node.content)}</div>` }
        : undefined;

export const AST_QUOTE_RULE: AstRenderRule = input =>
    isEnvironmentNode(input.node) && QUOTE_ENVIRONMENTS.has(environmentName(input.node) ?? '') && Array.isArray(input.node.content)
        ? { html: `<blockquote class="latex-quote">${input.renderChildren(input.node.content)}</blockquote>` }
        : undefined;

export const AST_ACKNOWLEDGMENT_RULE: AstRenderRule = input => {
    const envName = environmentName(input.node);
    if (!isEnvironmentNode(input.node) || !envName || !ACKNOWLEDGMENT_ENVIRONMENTS.has(envName) || !Array.isArray(input.node.content)) {
        return undefined;
    }
    const attachedTitle = readNodeArgument(input.node, '[', 0)?.content ?? [];
    const { head, tail } = attachedTitle.length > 0
        ? { head: attachedTitle, tail: input.node.content }
        : splitLeadingBracketNodes(input.node.content);
    const heading = head.length > 0 ? input.renderChildren(head).trim() : 'Acknowledgments';
    return { html: `<section class="latex-acknowledgments"><h2>${heading}</h2>${input.renderChildren(tail)}</section>` };
};

export const AST_MINIPAGE_RULE: AstRenderRule = input => {
    if (!isEnvironmentNode(input.node, 'minipage') || !Array.isArray(input.node.content)) { return undefined; }
    const width = latexRelativeWidthPercent(astNodesToLatex(readNodeArgument(input.node, '{', 0)?.content ?? []));
    const body = input.renderChildren(input.node.content);
    return { html: `<div class="latex-minipage" style="width:${width ?? 100}%">${body}</div>` };
};

export const AST_MAKETITLE_RULE: AstRenderRule = (input, context) => {
    if (!isMacroNode(input.node, 'maketitle')) { return undefined; }
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
};

export const AST_ABSTRACT_KEYWORDS_RULE: AstRenderRule = (input, context) => {
    if (isEnvironmentNode(input.node, 'abstract') && Array.isArray(input.node.content)) {
        return { html: `<div class="latex-abstract"><span class="latex-abstract-title">Abstract</span>${input.renderChildren(input.node.content)}</div>` };
    }
    if (isEnvironmentNode(input.node) && KEYWORD_ENVIRONMENTS.has(environmentName(input.node) ?? '') && Array.isArray(input.node.content)) {
        const content = normalizeLatexKeywordSeparators(context.sourceContent(input.node.content));
        return { html: `<div class="latex-keywords"><strong>Keywords:</strong> ${input.renderSource(content)}</div>` };
    }

    if (!isMacroNode(input.node)
        || (!ABSTRACT_MACROS.has(input.node.content) && !KEYWORD_MACROS.has(input.node.content))) {
        return undefined;
    }

    const args = readAstCommandNodeArguments(input);
    const contentNodes = args.requiredArgs[0] ?? [];
    const content = KEYWORD_MACROS.has(input.node.content)
        ? input.renderSource(normalizeLatexKeywordSeparators(astNodesToLatex(contentNodes)))
        : input.renderChildren(contentNodes);
    if (ABSTRACT_MACROS.has(input.node.content)) {
        return {
            html: `<div class="latex-abstract"><span class="latex-abstract-title">Abstract</span>${content}</div>`,
            consumedNodes: args.consumedNodes
        };
    }
    return {
        html: `<div class="latex-keywords"><strong>Keywords:</strong> ${content}</div>`,
        consumedNodes: args.consumedNodes
    };
};

export const AST_BIBLIOGRAPHY_RULE: AstRenderRule = (input, context) => {
    const renderText = (value: string) => renderInlineLatexSource(value, context);
    if (isMacroNode(input.node) && ['bibliographystyle', 'addbibresource'].includes(input.node.content)) {
        return { html: '', consumedNodes: readAstCommandArguments(input).consumedNodes };
    }
    if (isEnvironmentNode(input.node, 'thebibliography') && Array.isArray(input.node.content)) {
        const entries = Array.from(BibTexParser.parseBibItems(context.sourceSlice(input.node)).values());
        return { html: entries.length > 0 ? renderBibliographyItemsHtml(entries.map(entry => ({ key: entry.key, entry })), AST_BIB_RENDERER, renderText) : '' };
    }
    if (!isMacroNode(input.node) || !['bibliography', 'printbibliography'].includes(input.node.content)) {
        return undefined;
    }
    return {
        html: renderCitedBibliographyHtml(context.getCitedKeys(), context.bibEntries, AST_BIB_RENDERER, renderText),
        consumedNodes: readAstCommandArguments(input).consumedNodes
    };
};

export const AST_LINK_RULE: AstRenderRule = (input, context) => {
    if (!isMacroNode(input.node) || !['href', 'url'].includes(input.node.content)) {
        return undefined;
    }
    const args = readAstCommandNodeArguments(input, input.node.content === 'href' ? 2 : 1);
    const rawUrl = astNodesToText(args.requiredArgs[0] ?? []);
    const label = input.node.content === 'href' ? args.requiredArgs[1] : undefined;
    const content = label ? input.renderChildren(label) : renderInlineLatexSource(rawUrl, context);
    return {
        html: renderExternalLinkHtml(rawUrl, content, `latex-${input.node.content}`) ?? content,
        consumedNodes: args.consumedNodes
    };
};
