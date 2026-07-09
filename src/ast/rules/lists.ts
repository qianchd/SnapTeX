import { formatEnumerateLabel } from '../../utils';
import type { SnaptexAstArgument, SnaptexAstNode } from '../types';
import { argumentText, environmentName, isEnvironmentNode, isMacroNode, readNodeArgument } from '../visit-utils';
import type { AstRenderContext, AstRenderRule } from './index';
import { renderInlineLatexSource } from './index';

interface AstListItem {
    label?: SnaptexAstArgument;
    content: readonly SnaptexAstNode[];
}

const LIST_ENVIRONMENTS = new Set(['itemize', 'enumerate']);

function itemBodyArgument(node: SnaptexAstNode): SnaptexAstArgument | undefined {
    if (!Array.isArray(node.args)) {
        return undefined;
    }
    for (let index = node.args.length - 1; index >= 0; index--) {
        if (node.args[index].openMark === '') {
            return node.args[index];
        }
    }
    return undefined;
}

function readListItems(nodes: readonly SnaptexAstNode[]): AstListItem[] {
    return nodes.flatMap(node => {
        if (!isMacroNode(node, 'item')) {
            return [];
        }

        return [{
            label: readNodeArgument(node, '[', 0),
            content: itemBodyArgument(node)?.content ?? []
        }];
    });
}

function argumentSource(argument: SnaptexAstArgument | undefined, context: AstRenderContext): string {
    return argument
        ? (context.sourceContent(argument.content).trim() || argumentText(argument).trim())
        : '';
}

export const AST_LIST_RULE: AstRenderRule = {
    name: 'ast-list',
    match: input => LIST_ENVIRONMENTS.has(environmentName(input.node) ?? ''),
    render: (input, context) => {
        if (!isEnvironmentNode(input.node) || !Array.isArray(input.node.content)) {
            return undefined;
        }

        const envName = environmentName(input.node);
        const items = readListItems(input.node.content);
        if (!envName || items.length === 0) {
            return undefined;
        }

        const tagName = envName === 'enumerate' ? 'ol' : 'ul';
        const template = argumentSource(readNodeArgument(input.node, '[', 0), context);
        const className = template || items.some(item => item.label) ? 'latex-list latex-list-custom-label' : 'latex-list';
        const itemHtml = items.map((item, index) => {
            const label = argumentSource(item.label, context) || (template ? formatEnumerateLabel(template, index + 1) : '');
            const labelHtml = label ? `<span class="latex-list-label">${renderInlineLatexSource(label, context)}</span> ` : '';
            return `<li>${labelHtml}${input.renderChildren(item.content).trim()}</li>`;
        }).join('');

        return { html: `<${tagName} class="${className}">${itemHtml}</${tagName}>` };
    }
};
