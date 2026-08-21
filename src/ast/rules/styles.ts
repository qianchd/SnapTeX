import { hasBlockLevelHtml } from '../../rule-helpers';
import { countLatexMacroArguments, escapeHtmlAttribute, expandLatexTextMacros } from '../../utils';
import type { SnaptexAstNode } from '../types';
import { argumentText, firstSignificantNode, isGroupNode, isMacroNode, readRequiredMacroArgument } from '../visit-utils';
import { readAstCommandArguments, renderInlineLatexSource, type AstRenderRule } from './index';

const TEXT_STYLE_CSS = new Map([
    ['textbf', 'font-weight: 600'],
    ['bf', 'font-weight: 600'],
    ['emph', 'font-style: italic'],
    ['textit', 'font-style: italic'],
    ['it', 'font-style: italic'],
    ['texttt', 'font-family: monospace'],
    ['tt', 'font-family: monospace'],
    ['textsf', 'font-family: sans-serif'],
    ['sf', 'font-family: sans-serif'],
    ['textrm', 'font-family: serif'],
    ['rm', 'font-family: serif'],
    ['underline', 'text-decoration: underline']
]);

function wrapStyledHtml(html: string, style: string): string {
    const tag = hasBlockLevelHtml(html) || html.includes('\n\n') ? 'div' : 'span';
    const className = tag === 'div' ? ' class="latex-style-scope"' : '';
    return `<${tag}${className} style="${escapeHtmlAttribute(style)}">${html}</${tag}>`;
}

function nodesAfterLeadingStyle(nodes: readonly SnaptexAstNode[], macroIndex: number): readonly SnaptexAstNode[] {
    let start = macroIndex + 1;
    while (nodes[start]?.type === 'whitespace') {
        start++;
    }
    return nodes.slice(start);
}

function styleFromColorMacro(node: SnaptexAstNode): string | undefined {
    if (!isMacroNode(node, 'color')) {
        return undefined;
    }
    const color = argumentText(readRequiredMacroArgument(node)).trim();
    return color ? `color: ${color}` : undefined;
}

export const AST_TEXT_STYLE_RULE: AstRenderRule = (input, context) => {
    const node = input.node;

    if (isGroupNode(node)) {
        const first = firstSignificantNode(node.content);
        if (!first || !isMacroNode(first.node)) {
            return undefined;
        }
        const style = styleFromColorMacro(first.node) ?? TEXT_STYLE_CSS.get(first.node.content);
        return style
            ? { html: wrapStyledHtml(input.renderChildren(nodesAfterLeadingStyle(node.content, first.index)), style) }
            : undefined;
    }

    if (!isMacroNode(node)) {
        return undefined;
    }

    if (node.content === 'textcolor') {
        const color = argumentText(readRequiredMacroArgument(node, 0)).trim();
        const content = readRequiredMacroArgument(node, 1)?.content ?? [];
        return color ? { html: wrapStyledHtml(input.renderChildren(content), `color: ${color}`) } : undefined;
    }

    if (node.content === 'uppercase') {
        const content = argumentText(readRequiredMacroArgument(node)).toUpperCase();
        return { html: context.escapeHtml(content) };
    }

    const style = TEXT_STYLE_CSS.get(node.content);
    const content = readRequiredMacroArgument(node)?.content ?? [];
    return style
        ? { html: content.length > 0 ? wrapStyledHtml(input.renderChildren(content), style) : '' }
        : undefined;
};

export const AST_USER_MACRO_RULE: AstRenderRule = (input, context) => {
    if (!isMacroNode(input.node)) { return undefined; }

    const macros = context.metadata?.macros ?? {};
    const name = `\\${input.node.content}`;
    const definition = macros[name];
    if (!definition) { return undefined; }
    const argCount = countLatexMacroArguments(definition);
    const args = argCount > 0
        ? readAstCommandArguments(input, argCount)
        : { requiredArgs: [], consumedNodes: 1 };
    if (args.requiredArgs.length < argCount) { return undefined; }

    const source = context.sourceSlice(input.node)
        + input.siblings.slice(input.index + 1, input.index + args.consumedNodes)
            .map(context.sourceSlice)
            .join('');
    const expanded = expandLatexTextMacros(source, macros);
    return {
        html: expanded === source ? renderInlineLatexSource(source, context) : input.renderSource(expanded),
        consumedNodes: args.consumedNodes
    };
};
