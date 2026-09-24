import { hasBlockLevelHtml } from '../../rule-helpers';
import { stripLatexDefinitions } from '../../metadata';
import { escapeHtmlAttribute, expandLatexTextMacros, latexColorStyle, latexTextStyleCss } from '../../utils';
import type { SnaptexAstNode } from '../types';
import { argumentText, astNodesToText, firstSignificantNode, isGroupNode, isMacroNode, readOptionalMacroArgument, readRequiredMacroArgument } from '../visit-utils';
import { readAstCommandArguments, readAstCommandNodeArguments, renderInlineLatexSource, type AstRenderRule } from './index';

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

function styleFromColorMacro(node: SnaptexAstNode, colors?: Readonly<Record<string, string>>): string | undefined {
    if (!isMacroNode(node, 'color')) {
        return undefined;
    }
    const color = argumentText(readRequiredMacroArgument(node)).trim();
    const model = argumentText(readOptionalMacroArgument(node)).trim();
    return color ? latexColorStyle(color, colors, model) : undefined;
}

export const AST_TEXT_STYLE_RULE: AstRenderRule = (input, context) => {
    const node = input.node;

    if (isGroupNode(node)) {
        const first = firstSignificantNode(node.content);
        if (!first || !isMacroNode(first.node)) {
            return undefined;
        }
        const style = styleFromColorMacro(first.node, context.metadata?.colors) ?? latexTextStyleCss(first.node.content);
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
        const model = argumentText(readOptionalMacroArgument(node)).trim();
        return color
            ? { html: wrapStyledHtml(input.renderChildren(content), latexColorStyle(color, context.metadata?.colors, model)) }
            : undefined;
    }

    if (node.content === 'color') {
        const args = readAstCommandNodeArguments(input);
        const color = astNodesToText(args.requiredArgs[0] ?? []).trim();
        const model = astNodesToText(args.optionalArgs[0] ?? []).trim();
        return color
            ? {
                html: wrapStyledHtml(
                    input.renderChildren(input.siblings.slice(input.index + args.consumedNodes)),
                    latexColorStyle(color, context.metadata?.colors, model)
                ),
                consumedNodes: input.siblings.length - input.index
            }
            : undefined;
    }

    if (node.content === 'uppercase') {
        const content = argumentText(readRequiredMacroArgument(node)).toUpperCase();
        return { html: context.escapeHtml(content) };
    }

    const style = latexTextStyleCss(node.content);
    const args = style ? readAstCommandNodeArguments(input) : undefined;
    const content = args?.requiredArgs[0] ?? [];
    return style
        ? {
            html: content.length > 0 ? wrapStyledHtml(input.renderChildren(content), style) : '',
            consumedNodes: args?.consumedNodes
        }
        : undefined;
};

export const AST_USER_MACRO_RULE: AstRenderRule = (input, context) => {
    if (!isMacroNode(input.node)) { return undefined; }

    const macros = context.metadata?.macros ?? {};
    const name = `\\${input.node.content}`;
    const definition = macros[name];
    if (!definition) { return undefined; }
    const requiredArgCount = definition.argumentCount - (definition.defaultArgument === undefined ? 0 : 1);
    const args = definition.argumentCount > 0
        ? readAstCommandArguments(input, requiredArgCount)
        : { requiredArgs: [], consumedNodes: 1 };
    if (args.requiredArgs.length < requiredArgCount) { return undefined; }

    const source = context.sourceSlice(input.node)
        + input.siblings.slice(input.index + 1, input.index + args.consumedNodes)
            .map(context.sourceSlice)
            .join('');
    const expanded = stripLatexDefinitions(expandLatexTextMacros(source, macros));
    return {
        html: expanded === source ? renderInlineLatexSource(source, context) : input.renderSource(expanded),
        consumedNodes: args.consumedNodes
    };
};
