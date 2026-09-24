import { getTheoremDisplayName, PROOF_ENVS, THEOREM_ENVS } from '../../patterns';
import { renderTheoremHeaderHtml } from '../../rule-helpers';
import type { SnaptexAstNode } from '../types';
import { astNodesToText, environmentName, isEnvironmentNode, isGroupNode, isMacroNode, readBracketNodes, readNodeArgument, skipWhitespaceOrComments, splitLeadingBracketNodes } from '../visit-utils';
import { readAstCommandNodeArguments, renderInlineLatexSource, type AstRenderContext, type AstRenderInput, type AstRenderRule } from './index';

const THEOREM_ENVIRONMENTS = new Set<string>(THEOREM_ENVS);
const PROOF_ENVIRONMENTS = new Set<string>(PROOF_ENVS);
const PROOF_END_HTML = ' <span style="float:right;">QED</span>';

function environmentTitleAndBody(node: SnaptexAstNode): { title: readonly SnaptexAstNode[]; body: readonly SnaptexAstNode[] } {
    const body = Array.isArray(node.content) ? node.content : [];
    const attachedTitle = readNodeArgument(node, '[', 0)?.content ?? [];
    if (attachedTitle.length > 0) {
        return { title: attachedTitle, body };
    }
    const { head, tail } = splitLeadingBracketNodes(body);
    return { title: head, body: tail };
}

function proofHeading(input: AstRenderInput, title: readonly SnaptexAstNode[]): string {
    return title.length > 0 ? `Proof (${input.renderChildren(title).trim()}).` : 'Proof.';
}

function theoremHeaderHtml(input: AstRenderInput, displayName: string, title: readonly SnaptexAstNode[], numbered: boolean): string {
    return renderTheoremHeaderHtml(displayName, input.renderChildren(title).trim(), numbered);
}

function theoremPresentation(envName: string, context: AstRenderContext): { displayName: string; numbered: boolean } | undefined {
    const baseEnvName = envName.replace(/\*$/, '');
    const definition = context.metadata?.environments[baseEnvName];
    if (!THEOREM_ENVIRONMENTS.has(baseEnvName) && definition?.kind !== 'theorem') { return undefined; }
    return {
        displayName: definition?.kind === 'theorem'
            ? renderInlineLatexSource(definition.displayName, context)
            : getTheoremDisplayName(baseEnvName),
        numbered: baseEnvName === envName && (definition?.kind !== 'theorem' || definition.numbered)
    };
}

function theoremHtml(input: AstRenderInput, displayName: string, title: readonly SnaptexAstNode[], body: readonly SnaptexAstNode[], numbered = true): string {
    return `<div class="latex-theorem">${theoremHeaderHtml(input, displayName, title, numbered)}${input.renderChildren(body)}</div>`;
}

function restatableParts(node: SnaptexAstNode): { envName: string; title: readonly SnaptexAstNode[]; body: readonly SnaptexAstNode[] } | undefined {
    const content = Array.isArray(node.content) ? node.content : [];
    const bracket = readBracketNodes(content, skipWhitespaceOrComments(content, 0));
    let cursor = skipWhitespaceOrComments(content, bracket?.nextIndex ?? 0);
    const envName = groupText(content[cursor]);
    cursor = skipWhitespaceOrComments(content, cursor + 1);
    if (!THEOREM_ENVIRONMENTS.has(envName) || !groupText(content[cursor])) {
        return undefined;
    }
    return {
        envName,
        title: bracket?.content ?? [],
        body: content.slice(skipWhitespaceOrComments(content, cursor + 1))
    };
}

export const AST_THEOREM_RULE: AstRenderRule = (input, context) => {
    const envName = environmentName(input.node);
    if (!isEnvironmentNode(input.node) || !envName || !Array.isArray(input.node.content)) {
        return undefined;
    }

    if (envName === 'restatable') {
        const parts = restatableParts(input.node);
        return parts ? { html: theoremHtml(input, getTheoremDisplayName(parts.envName), parts.title, parts.body) } : undefined;
    }
    const presentation = theoremPresentation(envName, context);
    if (!presentation) { return undefined; }

    const { title, body } = environmentTitleAndBody(input.node);
    return { html: theoremHtml(input, presentation.displayName, title, body, presentation.numbered) };
};

export const AST_PROOF_RULE: AstRenderRule = input => {
    const envName = environmentName(input.node);
    if (!isEnvironmentNode(input.node) || !envName || !PROOF_ENVIRONMENTS.has(envName) || !Array.isArray(input.node.content)) {
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

export const AST_THEOREM_BOUNDARY_RULE: AstRenderRule = (input, context) => {
    if (!isMacroNode(input.node)
        || (input.node.content !== 'begin' && input.node.content !== 'end')) {
        return undefined;
    }

    const args = readAstCommandNodeArguments(input);
    const envName = astNodesToText(args.requiredArgs[0] ?? []).trim();
    const isProof = PROOF_ENVIRONMENTS.has(envName);
    const presentation = theoremPresentation(envName, context);
    if (!isProof && !presentation) { return undefined; }

    if (input.node.content === 'end') {
        return {
            html: isProof ? PROOF_END_HTML : '',
            consumedNodes: args.consumedNodes
        };
    }

    const bracket = readBracketNodes(input.siblings, skipWhitespaceOrComments(input.siblings, input.index + args.consumedNodes));
    const title = bracket?.content ?? [];
    return {
        html: `<span class="no-indent-marker"></span>${isProof
            ? `<strong>${proofHeading(input, title)}</strong> `
            : theoremHeaderHtml(input, presentation!.displayName, title, presentation!.numbered)}`,
        consumedNodes: bracket ? bracket.nextIndex - input.index : args.consumedNodes
    };
};
