import { getTheoremDisplayName, REGEX_STR } from '../../patterns';
import type { SnaptexAstNode } from '../types';
import { astNodesToText, environmentName, isEnvironmentNode, isGroupNode, isMacroNode, readBracketNodes, readNodeArgument, skipWhitespaceOrComments } from '../visit-utils';
import type { AstRenderInput, AstRenderRule } from './index';

const THEOREM_ENVIRONMENTS = new Set(REGEX_STR.THEOREM_ENVS.split('|'));
const PROOF_END_HTML = ' <span style="float:right;">QED</span>';

function readLeadingBracketTitle(nodes: readonly SnaptexAstNode[]): { title: readonly SnaptexAstNode[]; body: readonly SnaptexAstNode[] } {
    const bracket = readBracketNodes(nodes, skipWhitespaceOrComments(nodes, 0));
    if (!bracket) {
        return { title: [], body: nodes };
    }

    return { title: bracket.content, body: nodes.slice(bracket.nextIndex) };
}

function environmentTitleAndBody(node: SnaptexAstNode): { title: readonly SnaptexAstNode[]; body: readonly SnaptexAstNode[] } {
    const body = Array.isArray(node.content) ? node.content : [];
    const attachedTitle = readNodeArgument(node, '[', 0)?.content ?? [];
    if (attachedTitle.length > 0) {
        return { title: attachedTitle, body };
    }
    return readLeadingBracketTitle(body);
}

function proofHeading(input: AstRenderInput, title: readonly SnaptexAstNode[]): string {
    return title.length > 0 ? `Proof (${input.renderChildren(title).trim()}).` : 'Proof.';
}

export const AST_THEOREM_RULE: AstRenderRule = input => {
    const envName = environmentName(input.node);
    if (!isEnvironmentNode(input.node) || !envName || !THEOREM_ENVIRONMENTS.has(envName) || !Array.isArray(input.node.content)) {
        return undefined;
    }

    const { title, body } = environmentTitleAndBody(input.node);
    const titleHtml = title.length > 0 ? `&nbsp;(${input.renderChildren(title).trim()}).` : '.';
    const header = `<span class="theorem-title"><strong>${getTheoremDisplayName(envName)} <span class="sn-cnt" data-type="thm"></span></strong>${titleHtml}</span>&nbsp; `;
    return { html: `<div class="latex-theorem">${header}${input.renderChildren(body)}</div>` };
};

export const AST_PROOF_RULE: AstRenderRule = input => {
    if (!isEnvironmentNode(input.node, 'proof') || !Array.isArray(input.node.content)) {
        return undefined;
    }

    const { title, body } = environmentTitleAndBody(input.node);
    return {
        html: `<div class="latex-proof"><strong>${proofHeading(input, title)}</strong> ${input.renderChildren(body)}${PROOF_END_HTML}</div>`
    };
};

function groupText(node: SnaptexAstNode | undefined): string {
    return isGroupNode(node) ? astNodesToText(node.content).trim() : '';
}

export const AST_PROOF_BOUNDARY_RULE: AstRenderRule = input => {
    if (!isMacroNode(input.node)
        || !['begin', 'end'].includes(input.node.content)
        || groupText(input.siblings[input.index + 1]) !== 'proof') {
        return undefined;
    }

    if (input.node.content === 'end') {
        return {
            html: PROOF_END_HTML,
            consumedNodes: 2
        };
    }

    const bracket = readBracketNodes(input.siblings, skipWhitespaceOrComments(input.siblings, input.index + 2));
    return {
        html: `<span class="no-indent-marker"></span><strong>${proofHeading(input, bracket?.content ?? [])}</strong> `,
        consumedNodes: bracket ? bracket.nextIndex - input.index : 2
    };
};
