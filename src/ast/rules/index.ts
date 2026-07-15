import { CITATION_COMMANDS, REGEX_STR } from '../../patterns';
import { renderInlineLatexHtml, renderKatexHtml, renderReferenceLinksHtml } from '../../rule-helpers';
import {
    createHiddenLabelAnchor,
    escapeHtml,
    escapeHtmlAttribute,
} from '../../utils';
import type { BibEntry, PreambleData } from '../../types';
import { parseLatexWithLoadedParser } from '../parse';
import type { SnaptexAstNode } from '../types';
import {
    argumentText,
    astNodesRange,
    astNodesToText,
    getSourcePosition,
    isCommentNode,
    isGroupNode,
    isMacroNode,
    isVerbatimLikeNode,
    readBracketNodes,
    readOptionalMacroArgument,
    readRequiredMacroArgument
} from '../visit-utils';

const MAX_GENERATED_SOURCE_DEPTH = 8;

export const AST_REF_MACROS = new Set(['ref', 'eqref']);
export const AST_CITATION_MACROS = new Set<string>(CITATION_COMMANDS);
export const AST_SECTION_MACROS = new Set(REGEX_STR.SECTION_LEVELS.split('|'));
export const AST_TEXT_STYLE_CSS: Record<string, string> = {
    textbf: 'font-weight: 600',
    bf: 'font-weight: 600',
    emph: 'font-style: italic',
    textit: 'font-style: italic',
    it: 'font-style: italic',
    texttt: 'font-family: monospace',
    tt: 'font-family: monospace',
    textsf: 'font-family: sans-serif',
    sf: 'font-family: sans-serif',
    textrm: 'font-family: serif',
    rm: 'font-family: serif',
    underline: 'text-decoration: underline'
};

export interface AstRenderInput {
    node: SnaptexAstNode;
    siblings: readonly SnaptexAstNode[];
    index: number;
    renderChildren(nodes: readonly SnaptexAstNode[]): string;
    renderSource(source: string): string;
}

export interface AstRenderResult {
    html: string;
    consumedNodes?: number;
}

export interface AstRenderRule {
    name: string;
    match(input: AstRenderInput): boolean;
    render(input: AstRenderInput, context: AstRenderContext): AstRenderResult | undefined;
}

export interface AstRenderContext {
    currentMacros: Record<string, string>;
    metadata?: PreambleData;
    bibEntries: Map<string, BibEntry>;
    escapeHtml(text: string): string;
    sourceSlice(node: SnaptexAstNode): string;
    sourceContent(nodes: readonly SnaptexAstNode[]): string;
    renderMath(tex: string, displayMode: boolean): string;
    renderLabel(label: string): string;
    renderRef(labels: readonly string[], type: 'ref' | 'eqref'): string;
    resolveCitation(key: string): number;
    renderCitation(command: string, keys: readonly string[], options: { pre?: string; post?: string }): string;
    getCitedKeys(): readonly string[];
    renderImage(path: string, options?: string): string;
}

interface AstRenderContextOverrides extends Partial<AstRenderContext> {
    sourceText?: string;
}

function sourceReaders(sourceText: string): Pick<AstRenderContext, 'sourceSlice' | 'sourceContent'> {
    return {
        sourceSlice: node => {
            const position = getSourcePosition(node);
            return position && sourceText
                ? sourceText.slice(position.start.offset, position.end.offset)
                : astNodesToText([node]);
        },
        sourceContent: nodes => {
            const range = astNodesRange(nodes);
            return range && sourceText ? sourceText.slice(range.start, range.end) : astNodesToText(nodes);
        }
    };
}

export interface AstCommandArguments {
    requiredArgs: string[];
    optionalArgs: string[];
    consumedNodes: number;
}

export function createDefaultAstRenderContext(overrides: AstRenderContextOverrides = {}): AstRenderContext {
    const sourceText = overrides.sourceText ?? '';

    return {
        currentMacros: {},
        bibEntries: new Map(),
        escapeHtml,
        ...sourceReaders(sourceText),
        renderMath: (tex, displayMode) => renderKatexHtml(tex, displayMode, overrides.currentMacros ?? {}),
        renderLabel: createHiddenLabelAnchor,
        renderRef: (labels, type) => renderReferenceLinksHtml(labels, type),
        resolveCitation: () => 1,
        renderCitation: (_command, keys) => `(${keys.map(key => escapeHtml(key)).join('; ')})`,
        getCitedKeys: () => [],
        renderImage: (path, options) => {
            const safePath = escapeHtmlAttribute(path.trim());
            const safeOptions = options ? ` data-options="${escapeHtmlAttribute(options)}"` : '';
            return `<img src="${safePath}" alt="${safePath}" class="latex-includegraphics"${safeOptions}>`;
        },
        ...overrides
    };
}

export function readAstCommandArguments(input: AstRenderInput, requiredArgCount = 1): AstCommandArguments {
    const requiredArgs: string[] = [];
    const optionalArgs: string[] = [];
    if (!isMacroNode(input.node)) {
        return { requiredArgs, optionalArgs, consumedNodes: 1 };
    }

    for (let index = 0; ; index++) {
        const argument = readOptionalMacroArgument(input.node, index);
        if (!argument) {
            break;
        }
        optionalArgs.push(argumentText(argument));
    }

    for (let index = 0; ; index++) {
        const argument = readRequiredMacroArgument(input.node, index);
        if (!argument) {
            break;
        }
        requiredArgs.push(argumentText(argument));
    }

    let cursor = input.index + 1;
    if (requiredArgs.length < requiredArgCount) {
        cursor = readDetachedArguments(input.siblings, cursor, optionalArgs, requiredArgs, requiredArgCount);
    }

    return {
        requiredArgs,
        optionalArgs,
        consumedNodes: Math.max(1, cursor - input.index)
    };
}

function readDetachedArguments(
    siblings: readonly SnaptexAstNode[],
    startIndex: number,
    optionalArgs: string[],
    requiredArgs: string[],
    requiredArgCount: number
): number {
    let cursor = skipAstWhitespace(siblings, startIndex);
    while (true) {
        const optionalGroup = readBracketNodes(siblings, cursor);
        if (!optionalGroup) {
            break;
        }
        optionalArgs.push(astNodesToText(optionalGroup.content));
        cursor = skipAstWhitespace(siblings, optionalGroup.nextIndex);
    }

    while (requiredArgs.length < requiredArgCount) {
        const requiredGroup = siblings[cursor];
        if (!isGroupNode(requiredGroup)) { break; }
        requiredArgs.push(astNodesToText(requiredGroup.content));
        cursor++;
        if (requiredArgs.length < requiredArgCount) {
            cursor = skipAstWhitespace(siblings, cursor);
        }
    }
    return cursor;
}

function skipAstWhitespace(nodes: readonly SnaptexAstNode[], index: number): number {
    while (nodes[index]?.type === 'whitespace') {
        index++;
    }
    return index;
}

export function renderInlineLatexSource(text: string, context: AstRenderContext): string {
    return renderInlineLatexHtml(text, tex => context.renderMath(tex, false));
}

export function renderAstNodesWithRules(
    nodes: readonly SnaptexAstNode[],
    rules: readonly AstRenderRule[],
    context: AstRenderContext = createDefaultAstRenderContext()
): string {
    return renderAstNodes(nodes, rules, context, 0);
}

function renderAstNodes(
    nodes: readonly SnaptexAstNode[],
    rules: readonly AstRenderRule[],
    context: AstRenderContext,
    generatedSourceDepth: number
): string {
    let html = '';

    for (let index = 0; index < nodes.length; index++) {
        const input: AstRenderInput = {
            node: nodes[index],
            siblings: nodes,
            index,
            renderChildren: childNodes => renderAstNodes(childNodes, rules, context, generatedSourceDepth),
            renderSource: source => generatedSourceDepth < MAX_GENERATED_SOURCE_DEPTH
                ? renderAstSource(source, rules, context, generatedSourceDepth + 1)
                : renderInlineLatexSource(source, context)
        };
        const result = renderAstNodeWithRules(input, rules, context);
        html += result.html;
        index += Math.max(1, result.consumedNodes ?? 1) - 1;
    }

    return html;
}

function renderAstSource(
    source: string,
    rules: readonly AstRenderRule[],
    context: AstRenderContext,
    generatedSourceDepth: number
): string {
    const parsed = parseLatexWithLoadedParser(source);
    if (!parsed?.ast || parsed.errors.length > 0) {
        return renderInlineLatexSource(source, context);
    }

    const sourceContext = { ...context, ...sourceReaders(source) };
    return renderAstNodes(parsed.ast.content, rules, sourceContext, generatedSourceDepth);
}

function renderAstNodeWithRules(
    input: AstRenderInput,
    rules: readonly AstRenderRule[],
    context: AstRenderContext
): AstRenderResult {
    for (const rule of rules) {
        if (!rule.match(input)) {
            continue;
        }
        const result = rule.render(input, context);
        if (result) {
            return result;
        }
    }

    return { html: renderFallbackNode(input.node, rules, context) };
}

function renderFallbackNode(
    node: SnaptexAstNode,
    rules: readonly AstRenderRule[],
    context: AstRenderContext
): string {
    if (isCommentNode(node)) {
        return '';
    }
    if (isVerbatimLikeNode(node)) {
        const content = Array.isArray(node.content)
            ? astNodesToText(node.content)
            : (typeof node.content === 'string' ? node.content : '');
        return `<pre class="latex-verbatim"><code>${context.escapeHtml(content.replace(/^\n|\n$/g, ''))}</code></pre>`;
    }
    if (node.type === 'whitespace') {
        return ' ';
    }
    if (node.type === 'parbreak') {
        return '\n\n';
    }
    if (isMacroNode(node)) {
        return context.escapeHtml(`\\${node.content}`);
    }
    if (typeof node.content === 'string') {
        return context.escapeHtml(node.content).replace(/~/g, '&nbsp;');
    }
    if (Array.isArray(node.content)) {
        return renderAstNodesWithRules(node.content, rules, context);
    }
    return '';
}
