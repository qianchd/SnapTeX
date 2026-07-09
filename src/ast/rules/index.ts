import { REGEX_STR } from '../../patterns';
import { renderInlineLatexHtml, renderKatexHtml, renderReferenceLinksHtml } from '../../rule-helpers';
import {
    createHiddenLabelAnchor,
    escapeHtml,
    escapeHtmlAttribute,
} from '../../utils';
import type { BibEntry, PreambleData } from '../../types';
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

export const AST_REF_MACROS = new Set(['ref', 'eqref']);
export const AST_CITATION_MACROS = new Set(REGEX_STR.CITATION_CMDS.split('|'));
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
    renderCitation(command: string, keys: readonly string[], options: { pre?: string; post?: string }): string;
    getCitedKeys(): readonly string[];
    renderImage(path: string, options?: string): string;
}

interface AstRenderContextOverrides extends Partial<AstRenderContext> {
    sourceText?: string;
}

export interface AstCommandArguments {
    requiredArgs: string[];
    optionalArgs: string[];
    consumedNodes: number;
}

export function createDefaultAstRenderContext(overrides: AstRenderContextOverrides = {}): AstRenderContext {
    const sourceText = overrides.sourceText ?? '';
    const sourceSlice = (node: SnaptexAstNode) => {
        const position = getSourcePosition(node);
        return position && sourceText
            ? sourceText.slice(position.start.offset, position.end.offset)
            : astNodesToText([node]);
    };
    const sourceContent = (nodes: readonly SnaptexAstNode[]) => {
        const range = astNodesRange(nodes);
        return range && sourceText ? sourceText.slice(range.start, range.end) : astNodesToText(nodes);
    };

    return {
        currentMacros: {},
        bibEntries: new Map(),
        escapeHtml,
        sourceSlice,
        sourceContent,
        renderMath: (tex, displayMode) => renderKatexHtml(tex, displayMode, overrides.currentMacros ?? {}),
        renderLabel: createHiddenLabelAnchor,
        renderRef: (labels, type) => renderReferenceLinksHtml(labels, type),
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

export function readAstCommandArguments(input: AstRenderInput): AstCommandArguments {
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
    if (requiredArgs.length === 0) {
        cursor = readDetachedArguments(input.siblings, cursor, optionalArgs, requiredArgs);
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
    requiredArgs: string[]
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

    const requiredGroup = siblings[cursor];
    if (isGroupNode(requiredGroup)) {
        requiredArgs.push(astNodesToText(requiredGroup.content));
        cursor++;
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
    let html = '';

    for (let index = 0; index < nodes.length; index++) {
        const input: AstRenderInput = {
            node: nodes[index],
            siblings: nodes,
            index,
            renderChildren: childNodes => renderAstNodesWithRules(childNodes, rules, context)
        };
        const result = renderAstNodeWithRules(input, rules, context);
        html += result.html;
        index += Math.max(1, result.consumedNodes ?? 1) - 1;
    }

    return html;
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
