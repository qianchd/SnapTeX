import type { TextRange } from '../types';
import type { AstSourcePosition, SnaptexAstArgument, SnaptexAstNode, SnaptexAstRoot } from './types';

const VERBATIM_LIKE_ENVIRONMENTS = new Set(['verbatim', 'lstlisting', 'minted']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

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
    const ranges: TextRange[] = [];
    const position = getSourcePosition(node);
    if (position) {
        ranges.push({ start: position.start.offset, end: position.end.offset });
    }
    if (!position && isAstArgument(node)) {
        const contentRange = astNodesRange(node.content);
        if (contentRange) {
            ranges.push({
                start: Math.max(0, contentRange.start - (node.openMark ? 1 : 0)),
                end: contentRange.end + (node.closeMark ? 1 : 0)
            });
        }
    }

    if ('args' in node && Array.isArray(node.args)) {
        node.args.map(astNodeRange).filter(isTextRange).forEach(range => ranges.push(range));
    }
    if ('content' in node && Array.isArray(node.content)) {
        node.content.map(astNodeRange).filter(isTextRange).forEach(range => ranges.push(range));
    }
    return mergeTextRanges(ranges);
}

export function astNodesRange(nodes: readonly SnaptexAstNode[]): TextRange | undefined {
    return mergeTextRanges(nodes.map(astNodeRange).filter(isTextRange));
}

function isTextRange(value: TextRange | undefined): value is TextRange {
    return value !== undefined;
}

function mergeTextRanges(ranges: readonly TextRange[]): TextRange | undefined {
    if (ranges.length === 0) { return undefined; }
    return {
        start: Math.min(...ranges.map(range => range.start)),
        end: Math.max(...ranges.map(range => range.end))
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

export function collectMacroArgumentTexts(nodes: readonly SnaptexAstNode[], macroName: string): string[] {
    const values: string[] = [];

    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        if (isCommentNode(node) || isVerbatimLikeNode(node)) {
            continue;
        }

        if (isMacroNode(node, macroName)) {
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
            values.push(...collectMacroArgumentTexts(node.content, macroName));
        }

        if (Array.isArray(node.args)) {
            for (const argument of node.args) {
                values.push(...collectMacroArgumentTexts(argument.content, macroName));
            }
        }
    }

    return values;
}

export function findMacroArgumentText(nodes: readonly SnaptexAstNode[], macroName: string): string | undefined {
    return collectMacroArgumentTexts(nodes, macroName)[0];
}

function childNodes(node: SnaptexAstNode): SnaptexAstNode[] {
    const children: SnaptexAstNode[] = [];
    if (Array.isArray(node.content)) {
        children.push(...node.content);
    }
    if (Array.isArray(node.args)) {
        for (const argument of node.args) {
            children.push(...argument.content);
        }
    }
    return children;
}

export function visitLatexAst(root: SnaptexAstRoot, visitor: (node: SnaptexAstNode) => void): void {
    const visitNode = (node: SnaptexAstNode) => {
        if (isCommentNode(node) || isVerbatimLikeNode(node)) {
            return;
        }
        visitor(node);
        childNodes(node).forEach(visitNode);
    };

    visitNode(root);
}
