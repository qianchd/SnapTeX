import { BibTexParser } from '../../bib';
import { ACKNOWLEDGMENT_ENVS, LATEX_CONTENT_WRAPPER_COMMANDS, LATEX_DIMENSION_SOURCE, LATEX_INLINE_NOTE_COMMANDS, LATEX_LAYOUT_BREAK_COMMANDS, LATEX_LAYOUT_SWITCH_COMMANDS, LATEX_OMITTED_ARGUMENT_COMMANDS, LATEX_PREVIEW_OMITTED_COMMANDS, LATEX_TEXT_ACCENTS, LATEX_UNBRACED_SPACING_COMMANDS, QUOTE_ENVS, TRANSPARENT_CONTAINER_ENVIRONMENTS } from '../../patterns';
import { latexRelativeWidthPercent, normalizeLatexKeywordSeparators, renderBibliographyItemsHtml, renderCitedBibliographyHtml, renderExternalLinkHtml, renderInlineLatexHtml, renderInlineNoteHtml, renderMaketitleAuthorsHtml, siunitxArgumentCount, siunitxMathSource } from '../../rule-helpers';
import { formatLatexRomanNumeral, resolveLatexTextAccent, resolveLatexTextSymbol } from '../../utils';
import { astNodesToLatex, astNodesToText, environmentName, isCommentNode, isEnvironmentNode, isMacroNode, isWhitespaceOrCommentNode, readNodeArgument, splitLeadingBracketNodes, stringNodeContent } from '../visit-utils';
import { readAstCommandArguments, readAstCommandNodeArguments, renderInlineLatexSource, type AstRenderContext, type AstRenderInput, type AstRenderRule } from './index';

const ABSTRACT_MACROS = new Set(['Abstract', 'abstract']);
const KEYWORD_MACROS = new Set(['Keywords', 'keywords', 'Keyword', 'keyword']);
const KEYWORD_ENVIRONMENTS = new Set(['IEEEkeywords', 'keywords', 'keyword']);
const QUOTE_ENVIRONMENTS = new Set<string>(QUOTE_ENVS);
const OMITTED_ARGUMENT_MACROS = new Map<string, number>(Object.entries(LATEX_OMITTED_ARGUMENT_COMMANDS));
const LAYOUT_ASSIGNMENT_MACROS = new Set(['baselineskip', 'parskip', 'parindent']);
const LAYOUT_BREAK_MACROS = new Set<string>(LATEX_LAYOUT_BREAK_COMMANDS);
const LAYOUT_SWITCH_MACROS = new Set<string>(LATEX_LAYOUT_SWITCH_COMMANDS);
const UNBRACED_SPACING_MACROS = new Set<string>(LATEX_UNBRACED_SPACING_COMMANDS);
const LEADING_DIMENSION_PATTERN = new RegExp(`^${LATEX_DIMENSION_SOURCE}`);
const OMITTED_MACROS = new Set<string>(LATEX_PREVIEW_OMITTED_COMMANDS);
const INLINE_NOTE_MACROS = new Set<string>(LATEX_INLINE_NOTE_COMMANDS);
const TEXT_ACCENT_MACROS = new Set(Object.keys(LATEX_TEXT_ACCENTS));
const ACKNOWLEDGMENT_ENVIRONMENTS = new Set<string>(ACKNOWLEDGMENT_ENVS);
const TRANSPARENT_ENVIRONMENTS = new Set<string>(TRANSPARENT_CONTAINER_ENVIRONMENTS);

const AST_BIB_RENDERER = { protectHtml: (_namespace: string, html: string) => html };

function renderTextAccent(command: string, input: AstRenderInput, context: AstRenderContext) {
    const args = readAstCommandArguments(input);
    const grouped = args.requiredArgs[0];
    if (grouped !== undefined) {
        const accent = resolveLatexTextAccent(command, grouped);
        return accent ? { html: context.escapeHtml(accent), consumedNodes: args.consumedNodes } : undefined;
    }

    let cursor = input.index + 1;
    while (isWhitespaceOrCommentNode(input.siblings[cursor])) { cursor++; }
    const node = input.siblings[cursor];
    const text = stringNodeContent(node) ?? (isMacroNode(node) && /^[ij]$/.test(node.content) ? node.content : '');
    const [base = '', ...rest] = Array.from(text);
    const accent = resolveLatexTextAccent(command, base);
    return accent ? {
        html: context.escapeHtml(accent + rest.join('')),
        consumedNodes: cursor - input.index + 1
    } : undefined;
}

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
    const renderText = (value: string) => renderInlineLatexHtml(
        value,
        tex => context.renderMath(tex, false),
        context.metadata?.colors
    );
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

export const AST_COMMON_MACRO_RULE: AstRenderRule = (input, context) => {
    if (!isMacroNode(input.node)) {
        return undefined;
    }

    if (input.node.content === 'appendix' || OMITTED_MACROS.has(input.node.content)) {
        return { html: '' };
    }
    if (input.node.content === 'begin' || input.node.content === 'end') {
        const args = readAstCommandArguments(input);
        if (TRANSPARENT_ENVIRONMENTS.has(args.requiredArgs[0])) {
            return { html: '', consumedNodes: args.consumedNodes };
        }
    }
    if (LAYOUT_SWITCH_MACROS.has(input.node.content)) {
        return {
            html: '',
            consumedNodes: readAstCommandArguments(input, 0).consumedNodes
        };
    }
    if (LAYOUT_BREAK_MACROS.has(input.node.content)) {
        return { html: '\n\n', consumedNodes: readAstCommandArguments(input, 0).consumedNodes };
    }
    if (UNBRACED_SPACING_MACROS.has(input.node.content)) {
        let cursor = input.index + 1;
        while (isWhitespaceOrCommentNode(input.siblings[cursor])) { cursor++; }
        const content = stringNodeContent(input.siblings[cursor]);
        const dimension = content && LEADING_DIMENSION_PATTERN.exec(content);
        if (dimension) {
            return {
                html: (input.node.content === 'vskip' ? '\n\n' : '') + input.renderSource(content.slice(dimension[0].length)),
                consumedNodes: cursor - input.index + 1
            };
        }
    }
    const omittedArgumentCount = OMITTED_ARGUMENT_MACROS.get(input.node.content);
    if (omittedArgumentCount !== undefined) {
        return { html: '', consumedNodes: readAstCommandArguments(input, omittedArgumentCount).consumedNodes };
    }
    if (LAYOUT_ASSIGNMENT_MACROS.has(input.node.content)) {
        return { html: '', consumedNodes: readAstCommandArguments(input).consumedNodes };
    }
    if (input.node.content === 'noindent') {
        return { html: '<span class="no-indent-marker"></span>' };
    }
    const textSymbol = resolveLatexTextSymbol(input.node.content);
    if (textSymbol) {
        return { html: context.escapeHtml(textSymbol) };
    }
    if (TEXT_ACCENT_MACROS.has(input.node.content)) {
        return renderTextAccent(input.node.content, input, context);
    }
    const wrapper = LATEX_CONTENT_WRAPPER_COMMANDS[input.node.content];
    if (wrapper) {
        const args = readAstCommandNodeArguments(input, wrapper.requiredArgs, wrapper.argumentOrder);
        return {
            html: context.escapeHtml(wrapper.prefix ?? '')
                + input.renderChildren(args.requiredArgs[wrapper.contentArg] ?? [])
                + context.escapeHtml(wrapper.suffix ?? ''),
            consumedNodes: args.consumedNodes
        };
    }
    if (input.node.content === 'ensuremath') {
        const args = readAstCommandArguments(input);
        return {
            html: context.renderMath(args.requiredArgs[0] ?? '', false),
            consumedNodes: args.consumedNodes
        };
    }
    if (['Rmnum', 'rmnum', 'romannumeral'].includes(input.node.content)) {
        const args = readAstCommandArguments(input);
        const value = formatLatexRomanNumeral(input.node.content, args.requiredArgs[0] ?? '');
        return value !== undefined
            ? { html: context.escapeHtml(value), consumedNodes: args.consumedNodes }
            : undefined;
    }
    if (input.node.content === '\\') {
        return { html: '<br/>' };
    }
    if (['%', '#', '&', '$', '{', '}'].includes(input.node.content)) {
        return { html: context.escapeHtml(input.node.content) };
    }
    if (INLINE_NOTE_MACROS.has(input.node.content)) {
        const args = readAstCommandArguments(input);
        return {
            html: renderInlineNoteHtml(input.renderChildren(args.requiredArgNodes[0] ?? [])),
            consumedNodes: args.consumedNodes
        };
    }
    const siunitxArgCount = siunitxArgumentCount(input.node.content);
    if (siunitxArgCount > 0) {
        const args = readAstCommandArguments(input, siunitxArgCount);
        return {
            html: context.renderMath(siunitxMathSource(input.node.content, args.requiredArgs) ?? '', false),
            consumedNodes: args.consumedNodes
        };
    }
    return undefined;
};
