import { getListTagName } from '../../patterns';
import { formatEnumerateLabel, normalizeEnumerateLabelTemplate } from '../../utils';
import type { SnaptexAstArgument, SnaptexAstNode } from '../types';
import { astNodesToLatex, environmentName, isEnvironmentNode, isMacroNode, readNodeArgument } from '../visit-utils';
import { renderInlineLatexSource, type AstRenderRule } from './index';

interface AstListItem {
    label?: SnaptexAstArgument;
    content: readonly SnaptexAstNode[];
}

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
    const items: AstListItem[] = [];
    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        if (!isMacroNode(node, 'item')) { continue; }

        const attachedBody = itemBodyArgument(node)?.content ?? [];
        let nextItem = index + 1;
        while (nextItem < nodes.length && !isMacroNode(nodes[nextItem], 'item')) { nextItem++; }
        items.push({
            label: readNodeArgument(node, '[', 0),
            content: attachedBody.length > 0 ? attachedBody : nodes.slice(index + 1, nextItem)
        });
        index = nextItem - 1;
    }
    return items;
}

function argumentSource(argument: SnaptexAstArgument | undefined): string {
    return argument ? astNodesToLatex(argument.content).trim() : '';
}

export const AST_LIST_RULE: AstRenderRule = (input, context) => {
    const envName = environmentName(input.node);
    const tagName = envName ? getListTagName(envName) : undefined;
    if (!isEnvironmentNode(input.node) || !tagName || !Array.isArray(input.node.content)) {
        return undefined;
    }

    const items = readListItems(input.node.content);
    if (items.length === 0) {
        return undefined;
    }

    const template = normalizeEnumerateLabelTemplate(argumentSource(readNodeArgument(input.node, '[', 0)));
    const className = template || items.some(item => item.label) ? 'latex-list latex-list-custom-label' : 'latex-list';
    const itemHtml = items.map((item, index) => {
        const label = argumentSource(item.label) || (template ? formatEnumerateLabel(template, index + 1) : '');
        const labelHtml = label ? `<span class="latex-list-label">${renderInlineLatexSource(label, context)}</span> ` : '';
        return `<li>${labelHtml}${input.renderChildren(item.content).trim()}</li>`;
    }).join('');

    return { html: `<${tagName} class="${className}">${itemHtml}</${tagName}>` };
};
