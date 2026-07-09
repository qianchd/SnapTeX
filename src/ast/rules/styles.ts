import { hasBlockLevelHtml } from '../../rule-helpers';
import { escapeHtmlAttribute } from '../../utils';
import type { SnaptexAstNode } from '../types';
import { argumentText, firstSignificantNode, isGroupNode, isMacroNode, readRequiredMacroArgument } from '../visit-utils';
import { AST_TEXT_STYLE_CSS, type AstRenderRule } from './index';

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

export const AST_TEXT_STYLE_RULE: AstRenderRule = {
    name: 'ast-text-style',
    match: input => {
        if (isGroupNode(input.node)) {
            const first = firstSignificantNode(input.node.content);
            return Boolean(first && isMacroNode(first.node) && (AST_TEXT_STYLE_CSS[first.node.content] || first.node.content === 'color'));
        }
        return isMacroNode(input.node) && (
            input.node.content in AST_TEXT_STYLE_CSS
            || input.node.content === 'textcolor'
            || input.node.content === 'uppercase'
        );
    },
    render: (input, context) => {
        const node = input.node;

        if (isGroupNode(node)) {
            const first = firstSignificantNode(node.content);
            if (!first || !isMacroNode(first.node)) {
                return undefined;
            }
            const style = styleFromColorMacro(first.node) ?? AST_TEXT_STYLE_CSS[first.node.content];
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

        const style = AST_TEXT_STYLE_CSS[node.content];
        const content = readRequiredMacroArgument(node)?.content ?? [];
        return style
            ? { html: content.length > 0 ? wrapStyledHtml(input.renderChildren(content), style) : '' }
            : undefined;
    }
};
