import type { TextRange } from '../types';
import { isRecord } from '../utils';
import type { AstSourcePosition, SnaptexAstArgument, SnaptexAstNode, SnaptexAstRoot } from './types';

const VERBATIM_LIKE_ENVIRONMENTS = new Set(['verbatim', 'lstlisting', 'minted']);

export type SnaptexAstMacro = SnaptexAstNode & {
    type: 'macro';
    content: string;
    escapeToken?: string;
    args?: SnaptexAstArgument[];
};

export function isMacroNode(node: unknown, name?: string): node is SnaptexAstMacro {
    return isRecord(node)
        && node.type === 'macro'
        && typeof node.content === 'string'
        && (name === undefined || node.content === name);
}

export type SnaptexAstEnvironment = SnaptexAstNode & {
    type: 'environment' | 'mathenv';
    env: string | { type: string; content?: string };
    content?: SnaptexAstNode[];
};

export function environmentName(node: unknown): string | undefined {
    if (!isRecord(node)) {
        return undefined;
    }
    if (typeof node.env === 'string') {
        return node.env;
    }
    if (isRecord(node.env) && typeof node.env.content === 'string') {
        return node.env.content;
    }
    return undefined;
}

export function isEnvironmentNode(node: unknown, name?: string): node is SnaptexAstEnvironment {
    const envName = environmentName(node);
    return isRecord(node)
        && (node.type === 'environment' || node.type === 'mathenv')
        && envName !== undefined
        && (name === undefined || envName === name);
}

export function isCommentNode(node: unknown): node is SnaptexAstNode & { type: 'comment'; content: string } {
    return isRecord(node) && node.type === 'comment';
}

export type SnaptexAstGroup = SnaptexAstNode & {
    type: 'group';
    content: SnaptexAstNode[];
};

export function isGroupNode(node: unknown): node is SnaptexAstGroup {
    return isRecord(node) && node.type === 'group' && Array.isArray(node.content);
}

export function isWhitespaceOrCommentNode(node: unknown): boolean {
    return isRecord(node) && (node.type === 'whitespace' || node.type === 'comment');
}

export function stringNodeContent(node: unknown): string | undefined {
    return isRecord(node) && node.type === 'string' && typeof node.content === 'string'
        ? node.content
        : undefined;
}

export function firstSignificantNode(nodes: readonly SnaptexAstNode[]): { node: SnaptexAstNode; index: number } | undefined {
    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        if (!isWhitespaceOrCommentNode(node)) {
            return { node, index };
        }
    }
    return undefined;
}

export function findAstNode<T extends SnaptexAstNode>(
    nodes: readonly SnaptexAstNode[],
    predicate: (node: SnaptexAstNode) => node is T
): T | undefined;
export function findAstNode(
    nodes: readonly SnaptexAstNode[],
    predicate: (node: SnaptexAstNode) => boolean
): SnaptexAstNode | undefined;
export function findAstNode(
    nodes: readonly SnaptexAstNode[],
    predicate: (node: SnaptexAstNode) => boolean
): SnaptexAstNode | undefined {
    for (const node of nodes) {
        if (predicate(node)) { return node; }
        if (Array.isArray(node.content)) {
            const match = findAstNode(node.content, predicate);
            if (match) { return match; }
        }
    }
    return undefined;
}

export function skipWhitespaceOrComments(nodes: readonly SnaptexAstNode[], index: number): number {
    while (isWhitespaceOrCommentNode(nodes[index])) {
        index++;
    }
    return index;
}

export function readBracketNodes(nodes: readonly SnaptexAstNode[], startIndex: number): { content: SnaptexAstNode[]; nextIndex: number } | undefined {
    if (stringNodeContent(nodes[startIndex]) !== '[') {
        return undefined;
    }

    const content: SnaptexAstNode[] = [];
    for (let index = startIndex + 1; index < nodes.length; index++) {
        const node = nodes[index];
        if (stringNodeContent(node) === ']') {
            return { content, nextIndex: index + 1 };
        }
        content.push(node);
    }
    return undefined;
}

export function isVerbatimLikeNode(node: unknown): boolean {
    const envName = environmentName(node);
    return isRecord(node)
        && envName !== undefined
        && (node.type === 'verbatim' || VERBATIM_LIKE_ENVIRONMENTS.has(envName));
}

export function getSourcePosition(node: unknown): AstSourcePosition | undefined {
    if (!isRecord(node) || !isRecord(node.position) || !isRecord(node.position.start) || !isRecord(node.position.end)) {
        return undefined;
    }

    const { start, end } = node.position;
    if (
        typeof start.offset !== 'number' ||
        typeof start.line !== 'number' ||
        typeof start.column !== 'number' ||
        typeof end.offset !== 'number' ||
        typeof end.line !== 'number' ||
        typeof end.column !== 'number'
    ) {
        return undefined;
    }

    return {
        start: {
            offset: start.offset,
            line: start.line,
            column: start.column
        },
        end: {
            offset: end.offset,
            line: end.line,
            column: end.column
        }
    };
}

function isAstArgument(node: SnaptexAstNode | SnaptexAstArgument): node is SnaptexAstArgument {
    return node.type === 'argument' && Array.isArray(node.content);
}

export function astNodeRange(node: SnaptexAstNode | SnaptexAstArgument): TextRange | undefined {
    let range: TextRange | undefined;
    const position = getSourcePosition(node);
    if (position) {
        range = { start: position.start.offset, end: position.end.offset };
    } else if ('content' in node && Array.isArray(node.content)) {
        const contentRange = astNodesRange(node.content);
        if (contentRange) {
            range = isAstArgument(node)
                ? {
                    start: Math.max(0, contentRange.start - (node.openMark ? 1 : 0)),
                    end: contentRange.end + (node.closeMark ? 1 : 0)
                }
                : contentRange;
        }
    }

    if ('args' in node && Array.isArray(node.args)) {
        for (const argument of node.args) {
            range = mergeTextRanges(range, astNodeRange(argument));
        }
    }
    return range;
}

export function astNodesRange(nodes: readonly SnaptexAstNode[]): TextRange | undefined {
    let range: TextRange | undefined;
    for (const node of nodes) {
        range = mergeTextRanges(range, astNodeRange(node));
    }
    return range;
}

function mergeTextRanges(left: TextRange | undefined, right: TextRange | undefined): TextRange | undefined {
    if (!left) { return right; }
    if (!right) { return left; }
    return {
        start: Math.min(left.start, right.start),
        end: Math.max(left.end, right.end)
    };
}

function nodeArguments(node: SnaptexAstNode): SnaptexAstArgument[] {
    return Array.isArray(node.args) ? node.args : [];
}

export function readNodeArgument(
    node: SnaptexAstNode,
    openMark: string,
    index: number
): SnaptexAstArgument | undefined {
    return nodeArguments(node).filter(argument => argument.openMark === openMark)[index];
}

export function readRequiredMacroArgument(node: SnaptexAstMacro, index = 0): SnaptexAstArgument | undefined {
    return readNodeArgument(node, '{', index);
}

export function readOptionalMacroArgument(node: SnaptexAstMacro, index = 0): SnaptexAstArgument | undefined {
    return readNodeArgument(node, '[', index);
}

export function astNodesToText(nodes: readonly SnaptexAstNode[]): string {
    return nodes.map(node => {
        if (node.type === 'whitespace') {
            return ' ';
        }
        if ('content' in node && typeof node.content === 'string') {
            return node.content;
        }
        if ('content' in node && Array.isArray(node.content)) {
            return astNodesToText(node.content);
        }
        return '';
    }).join('');
}

export function astNodesToLatex(nodes: readonly SnaptexAstNode[]): string {
    return nodes.map(node => {
        if (node.type === 'whitespace') {
            return ' ';
        }
        if (node.type === 'parbreak') {
            return '\n\n';
        }
        if (isMacroNode(node)) {
            const command = node.escapeToken === '' ? node.content : `\\${node.content}`;
            const args = nodeArguments(node)
                .map(argument => `${argument.openMark}${astNodesToLatex(argument.content)}${argument.closeMark}`)
                .join('');
            return command + args;
        }
        if (isGroupNode(node)) {
            return `{${astNodesToLatex(node.content)}}`;
        }
        if ('content' in node && typeof node.content === 'string') {
            return node.content;
        }
        if ('content' in node && Array.isArray(node.content)) {
            return astNodesToLatex(node.content);
        }
        return '';
    }).join('');
}

export function argumentText(argument: SnaptexAstArgument | undefined): string {
    return argument ? astNodesToText(argument.content) : '';
}

export function collectMacroArgumentTexts(nodes: readonly SnaptexAstNode[], macroNames: string | ReadonlySet<string>): string[] {
    const values: string[] = [];

    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        if (isCommentNode(node) || isVerbatimLikeNode(node)) {
            continue;
        }

        if (isMacroNode(node) && (typeof macroNames === 'string' ? node.content === macroNames : macroNames.has(node.content))) {
            const attachedArgument = argumentText(readRequiredMacroArgument(node));
            if (attachedArgument) {
                values.push(attachedArgument);
            } else {
                const next = nodes[index + 1];
                if (isGroupNode(next)) {
                    values.push(astNodesToText(next.content));
                }
            }
        }

        if (Array.isArray(node.content)) {
            values.push(...collectMacroArgumentTexts(node.content, macroNames));
        }

        if (Array.isArray(node.args)) {
            for (const argument of node.args) {
                values.push(...collectMacroArgumentTexts(argument.content, macroNames));
            }
        }
    }

    return values;
}

export function findMacroArgumentText(nodes: readonly SnaptexAstNode[], macroName: string): string | undefined {
    return collectMacroArgumentTexts(nodes, macroName)[0];
}

export function visitLatexAst(
    root: SnaptexAstRoot,
    visitor: (node: SnaptexAstNode, index: number, siblings: readonly SnaptexAstNode[]) => void
): void {
    const visitNodes = (nodes: readonly SnaptexAstNode[]) => nodes.forEach((node, index) => {
        if (isCommentNode(node) || isVerbatimLikeNode(node)) {
            return;
        }
        visitor(node, index, nodes);
        if (Array.isArray(node.content)) {
            visitNodes(node.content);
        }
        if (Array.isArray(node.args)) {
            node.args.forEach(argument => visitNodes(argument.content));
        }
    });

    visitor(root, 0, [root]);
    visitNodes(root.content);
}
