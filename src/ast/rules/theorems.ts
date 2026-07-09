import { getTheoremDisplayName, REGEX_STR } from '../../patterns';
import type { SnaptexAstNode } from '../types';
import { argumentText, astNodesToText, environmentName, isEnvironmentNode, isGroupNode, isMacroNode, readBracketNodes, readNodeArgument } from '../visit-utils';
import type { AstRenderRule } from './index';

const THEOREM_ENVIRONMENTS = new Set(REGEX_STR.THEOREM_ENVS.split('|'));

function optionalTitle(node: SnaptexAstNode): string {
    return argumentText(readNodeArgument(node, '[', 0)).trim();
}

function readLeadingBracketTitle(nodes: readonly SnaptexAstNode[]): { title: string; body: readonly SnaptexAstNode[] } {
    const start = nodes.findIndex(node => node.type !== 'whitespace');
    const bracket = start === -1 ? undefined : readBracketNodes(nodes, start);
    if (!bracket) {
        return { title: '', body: nodes };
    }

    return { title: astNodesToText(bracket.content).trim(), body: nodes.slice(bracket.nextIndex) };
}

function environmentTitleAndBody(node: SnaptexAstNode): { title: string; body: readonly SnaptexAstNode[] } {
    const body = Array.isArray(node.content) ? node.content : [];
    const attachedTitle = optionalTitle(node);
    if (attachedTitle) {
        return { title: attachedTitle, body };
    }
    return readLeadingBracketTitle(body);
}

export const AST_THEOREM_RULE: AstRenderRule = {
    name: 'ast-theorem',
    match: input => {
        const name = environmentName(input.node);
        return name !== undefined && THEOREM_ENVIRONMENTS.has(name);
    },
    render: (input, context) => {
        if (!isEnvironmentNode(input.node) || !Array.isArray(input.node.content)) {
            return undefined;
        }

        const envName = environmentName(input.node) ?? '';
        const { title, body } = environmentTitleAndBody(input.node);
        const titleHtml = title ? `&nbsp;(${context.escapeHtml(title)}).` : '.';
        const header = `<span class="theorem-title"><strong>${getTheoremDisplayName(envName)} <span class="sn-cnt" data-type="thm"></span></strong>${titleHtml}</span>&nbsp; `;
        return { html: `<div class="latex-theorem">${header}${input.renderChildren(body)}</div>` };
    }
};

export const AST_PROOF_RULE: AstRenderRule = {
    name: 'ast-proof',
    match: input => environmentName(input.node) === 'proof',
    render: input => {
        if (!isEnvironmentNode(input.node) || !Array.isArray(input.node.content)) {
            return undefined;
        }

        const { title, body } = environmentTitleAndBody(input.node);
        const proofTitle = title || 'Proof';
        return {
            html: `<div class="latex-proof"><strong>${proofTitle}.</strong> ${input.renderChildren(body)} <span style="float:right;">QED</span></div>`
        };
    }
};

function groupText(node: SnaptexAstNode | undefined): string {
    return isGroupNode(node) ? astNodesToText(node.content).trim() : '';
}

export const AST_PROOF_BOUNDARY_RULE: AstRenderRule = {
    name: 'ast-proof-boundary',
    match: input => isMacroNode(input.node) && ['begin', 'end'].includes(input.node.content) && groupText(input.siblings[input.index + 1]) === 'proof',
    render: input => {
        if (!isMacroNode(input.node)) {
            return undefined;
        }

        if (input.node.content === 'end') {
            return {
                html: ' <span style="float:right;">QED</span>',
                consumedNodes: 2
            };
        }

        const bracket = readBracketNodes(input.siblings, input.index + 2);
        const bracketText = bracket ? astNodesToText(bracket.content).trim() : '';
        const title = bracketText ? `Proof (${bracketText}).` : 'Proof.';
        return {
            html: `<span class="no-indent-marker"></span><strong>${title}</strong> `,
            consumedNodes: bracket ? bracket.nextIndex - input.index : 2
        };
    }
};
