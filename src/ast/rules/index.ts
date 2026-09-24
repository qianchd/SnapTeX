import { CITATION_COMMANDS, REFERENCE_COMMANDS, SECTION_LEVELS } from '../../patterns';
import { renderInlineLatexHtml, renderKatexHtml, renderReferenceLinksHtml } from '../../rule-helpers';
import {
    createHiddenLabelAnchor,
    escapeHtml,
    escapeHtmlAttribute,
    type LatexCommandArgumentSpec
} from '../../utils';
import type { BibEntry, LatexMacroDefinition, PreambleData } from '../../types';
import { parseLatexWithLoadedParser } from '../parse';
import type { SnaptexAstNode } from '../types';
import {
    astNodesRange,
    astNodesToLatex,
    astNodesToText,
    getSourcePosition,
    isCommentNode,
    isGroupNode,
    isMacroNode,
    isVerbatimLikeNode,
    readBracketNodes,
    skipWhitespaceOrComments,
    stringNodeContent,
    type SnaptexAstMacro
} from '../visit-utils';

const MAX_GENERATED_SOURCE_DEPTH = 8;

export const AST_REF_MACROS = new Set<string>(REFERENCE_COMMANDS);
export const AST_CITATION_MACROS = new Set<string>(CITATION_COMMANDS);
export const AST_SECTION_MACROS = new Set<string>(SECTION_LEVELS);

export interface AstRenderInput {
    node: SnaptexAstNode;
    siblings: readonly SnaptexAstNode[];
    index: number;
    renderChildren(nodes: readonly SnaptexAstNode[]): string;
    renderSource(source: string): string;
}

export type AstNodeLocation = Pick<AstRenderInput, 'node' | 'siblings' | 'index'>;

export interface AstRenderResult {
    html: string;
    consumedNodes?: number;
}

export interface AstMathRuleResult {
    replacement: string;
    consumedNodes?: number;
    placeholder?: { html: string; text: string };
    afterHtml?: string;
}

export interface AstMathRuleInput extends Omit<AstNodeLocation, 'node'> {
    node: SnaptexAstMacro;
    arguments: AstCommandArguments;
    sourceContent(nodes: readonly SnaptexAstNode[]): string;
}

export interface AstMathRule {
    readonly commands: readonly string[];
    apply(input: AstMathRuleInput, context: AstRenderContext): AstMathRuleResult | undefined;
}

export type AstRenderRule = (
    input: AstRenderInput,
    context: AstRenderContext
) => AstRenderResult | undefined;

export interface AstRenderContext {
    metadata?: PreambleData;
    bibEntries: ReadonlyMap<string, BibEntry>;
    astMathRules?: readonly AstMathRule[];
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

interface AstRenderContextOptions extends Partial<AstRenderContext> {
    sourceText?: string;
    currentMacros?: Readonly<Record<string, LatexMacroDefinition>>;
}

function sourceReaders(sourceText: string): Pick<AstRenderContext, 'sourceSlice' | 'sourceContent'> {
    return {
        sourceSlice: node => {
            const position = getSourcePosition(node);
            return position && sourceText
                ? sourceText.slice(position.start.offset, position.end.offset)
                : astNodesToLatex([node]);
        },
        sourceContent: nodes => {
            const range = astNodesRange(nodes);
            return range && sourceText ? sourceText.slice(range.start, range.end) : astNodesToLatex(nodes);
        }
    };
}

export interface AstCommandArguments {
    requiredArgs: string[];
    optionalArgs: string[];
    requiredArgNodes: SnaptexAstNode[][];
    optionalArgNodes: SnaptexAstNode[][];
    consumedNodes: number;
}

export function createDefaultAstRenderContext(options: AstRenderContextOptions = {}): AstRenderContext {
    const { sourceText = '', currentMacros = {}, ...overrides } = options;

    return {
        bibEntries: new Map(),
        escapeHtml,
        ...sourceReaders(sourceText),
        renderMath: (tex, displayMode) => renderKatexHtml(tex, displayMode, currentMacros),
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

export function readAstCommandArguments(
    input: AstNodeLocation,
    requiredArgCount = 1,
    argumentOrder?: readonly LatexCommandArgumentSpec[]
): AstCommandArguments {
    const args = readAstCommandNodeArguments(input, requiredArgCount, argumentOrder);
    return {
        requiredArgs: args.requiredArgs.map(astNodesToLatex),
        optionalArgs: args.optionalArgs.map(astNodesToLatex),
        requiredArgNodes: args.requiredArgs,
        optionalArgNodes: args.optionalArgs,
        consumedNodes: args.consumedNodes
    };
}

export function readAstCommandNodeArguments(
    input: AstNodeLocation,
    requiredArgCount = 1,
    argumentOrder?: readonly LatexCommandArgumentSpec[]
) {
    const requiredArgs: SnaptexAstNode[][] = [];
    const optionalArgs: SnaptexAstNode[][] = [];
    if (!isMacroNode(input.node)) {
        return { requiredArgs, optionalArgs, consumedNodes: 1 };
    }

    for (const argument of input.node.args ?? []) {
        if (argument.openMark === '[') {
            optionalArgs.push(argument.content);
        } else if (argument.openMark === '{') {
            requiredArgs.push(argument.content);
        }
    }

    let cursor = input.index + 1;
    if (requiredArgs.length < requiredArgCount) {
        const detachedOrder = requiredArgs.length === 0 && optionalArgs.length === 0 ? argumentOrder : undefined;
        cursor = readDetachedArguments(input.siblings, cursor, optionalArgs, requiredArgs, requiredArgCount, detachedOrder);
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
    optionalArgs: SnaptexAstNode[][],
    requiredArgs: SnaptexAstNode[][],
    requiredArgCount: number,
    argumentOrder?: readonly LatexCommandArgumentSpec[]
): number {
    let cursor = skipWhitespaceOrComments(siblings, startIndex);
    if (stringNodeContent(siblings[cursor]) === '*') {
        cursor = skipWhitespaceOrComments(siblings, cursor + 1);
    }
    if (argumentOrder) {
        for (const argument of argumentOrder) {
            cursor = skipWhitespaceOrComments(siblings, cursor);
            if (argument.delimiter === 'bracket') {
                const group = readBracketNodes(siblings, cursor);
                if (!group) {
                    if (argument.optional) { continue; }
                    return cursor;
                }
                optionalArgs.push(group.content);
                cursor = group.nextIndex;
            } else {
                const group = siblings[cursor];
                if (!isGroupNode(group)) {
                    if (!argument.optional) { return cursor; }
                    continue;
                }
                requiredArgs.push(group.content);
                cursor++;
            }
        }
        return cursor;
    }

    while (true) {
        const optionalGroup = readBracketNodes(siblings, cursor);
        if (!optionalGroup) {
            break;
        }
        optionalArgs.push(optionalGroup.content);
        cursor = skipWhitespaceOrComments(siblings, optionalGroup.nextIndex);
    }

    while (requiredArgs.length < requiredArgCount) {
        const requiredGroup = siblings[cursor];
        if (!isGroupNode(requiredGroup)) { break; }
        requiredArgs.push(requiredGroup.content);
        cursor++;
        if (requiredArgs.length < requiredArgCount) {
            cursor = skipWhitespaceOrComments(siblings, cursor);
        }
    }
    return cursor;
}

export function renderInlineLatexSource(text: string, context: AstRenderContext): string {
    return renderInlineLatexHtml(text, tex => context.renderMath(tex, false), context.metadata?.colors);
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
        const result = renderAstNodeWithRules(input, rules, context, generatedSourceDepth);
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
    context: AstRenderContext,
    generatedSourceDepth: number
): AstRenderResult {
    for (const rule of rules) {
        const result = rule(input, context);
        if (result) {
            return result;
        }
    }

    return { html: renderFallbackNode(input.node, rules, context, generatedSourceDepth) };
}

function renderFallbackNode(
    node: SnaptexAstNode,
    rules: readonly AstRenderRule[],
    context: AstRenderContext,
    generatedSourceDepth: number
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
        return renderAstNodes(node.content, rules, context, generatedSourceDepth);
    }
    return '';
}
