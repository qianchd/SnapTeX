import type { SnaptexAstNode } from '../types';
import {
    astNodesToText,
    environmentName,
    getSourcePosition,
    isGroupNode,
    isEnvironmentNode,
    isMacroNode,
    isWhitespaceOrCommentNode,
    readBracketNodes,
    readNodeArgument,
    readRequiredMacroArgument,
    skipWhitespaceOrComments,
    stringNodeContent,
    type SnaptexAstMacro
} from '../visit-utils';
import type { AstRenderContext, AstRenderInput, AstRenderRule } from './index';
import {
    algorithmicIndentAfter,
    algorithmicIndentBefore,
    algorithmicInlineMacroHtml,
    algorithmicItemAttributes,
    describeAlgorithmicCommand
} from '../../latex-algorithm';
import { renderLatexMakecellHtml, renderTableRowCells } from '../../latex-table';
import { renderCaptionHtml, renderNumberedCaptionPrefix, renderSubfigureWidthStyle } from '../../rule-helpers';

const FLOATS = new Set(['figure', 'figure*', 'table', 'table*', 'algorithm']);
const SUBFIGURE_ENVS = new Set(['subfigure', 'subfigure*']);
const TABULAR_ENVS = new Set(['tabular', 'tabular*', 'tabularx']);
const TABLENOTES_ENVS = new Set(['tablenotes']);
const ALGORITHMIC_ENVS = new Set(['algorithmic']);
const BOOKTABS_TABLE_MACROS = new Set(['toprule', 'midrule', 'bottomrule', 'cmidrule']);
const RULE_TABLE_MACROS = new Set(['hline', 'cline']);
const IGNORED_TABLE_MACROS = new Set([...BOOKTABS_TABLE_MACROS, ...RULE_TABLE_MACROS]);
const TABLE_NOTE_LAYOUT_MACROS = new Set(['footnotesize', 'small', 'scriptsize', 'tiny']);
const FLOAT_LAYOUT_MACROS = new Set(['centering', 'hfill', 'small', 'footnotesize']);
const TABLE_CELL_MACROS = new Set(['multicolumn', 'multirow', 'makecell', 'tnote']);

function captionHtml(
    input: AstRenderInput,
    contentNodes: readonly SnaptexAstNode[],
    className: string,
    prefixHtml: string,
    searchNested = false
): { html: string; nodes: Set<SnaptexAstNode> } {
    const nodes = new Set<SnaptexAstNode>();
    const caption = searchNested
        ? findFirstMacro(contentNodes, 'caption')
        : contentNodes.find((node): node is SnaptexAstMacro => isMacroNode(node, 'caption'));
    if (!caption) {
        return { html: '', nodes };
    }

    nodes.add(caption);
    const content = readRequiredMacroArgument(caption)?.content ?? [];
    return {
        html: renderCaptionHtml(className, input.renderChildren(content), prefixHtml),
        nodes
    };
}

function findFirstMacro(nodes: readonly SnaptexAstNode[], name: string): SnaptexAstMacro | undefined {
    return findFirstNode(nodes, (node): node is SnaptexAstMacro => isMacroNode(node, name));
}

function renderNestedLabels(input: AstRenderInput, nodes: readonly SnaptexAstNode[]): string {
    return nodes.map(node => {
        if (isMacroNode(node, 'label')) {
            return input.renderChildren([node]);
        }
        return Array.isArray(node.content) ? renderNestedLabels(input, node.content) : '';
    }).join('');
}

function visibleFloatChildren(nodes: readonly SnaptexAstNode[], omitted: Set<SnaptexAstNode>): SnaptexAstNode[] {
    const visible: SnaptexAstNode[] = [];
    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        if (omitted.has(node)) {
            continue;
        }
        if (isMacroNode(node) && FLOAT_LAYOUT_MACROS.has(node.content)) {
            continue;
        }
        if (isMacroNode(node, 'vspace')) {
            const nextIndex = skipWhitespaceOrComments(nodes, index + 1);
            if (isGroupNode(nodes[nextIndex])) {
                index = nextIndex;
            }
            continue;
        }
        visible.push(node);
    }
    return visible;
}

function stripLeadingEnvironmentOption(nodes: readonly SnaptexAstNode[]): SnaptexAstNode[] {
    const bracket = readBracketNodes(nodes, skipWhitespaceOrComments(nodes, 0));
    return bracket ? nodes.slice(bracket.nextIndex) : [...nodes];
}

function findFirstEnvironment(nodes: readonly SnaptexAstNode[], envs: ReadonlySet<string>): SnaptexAstNode | undefined {
    return findFirstNode(nodes, node => {
        const envName = environmentName(node);
        return envName !== undefined && envs.has(envName);
    });
}

function findFirstNode<T extends SnaptexAstNode>(
    nodes: readonly SnaptexAstNode[],
    predicate: (node: SnaptexAstNode) => node is T
): T | undefined;
function findFirstNode(
    nodes: readonly SnaptexAstNode[],
    predicate: (node: SnaptexAstNode) => boolean
): SnaptexAstNode | undefined;
function findFirstNode(
    nodes: readonly SnaptexAstNode[],
    predicate: (node: SnaptexAstNode) => boolean
): SnaptexAstNode | undefined {
    for (const node of nodes) {
        if (predicate(node)) {
            return node;
        }
        if (Array.isArray(node.content)) {
            const child = findFirstNode(node.content, predicate);
            if (child) {
                return child;
            }
        }
    }
    return undefined;
}

function splitTableNoteItems(nodes: readonly SnaptexAstNode[]): Array<{ label: readonly SnaptexAstNode[]; content: readonly SnaptexAstNode[] }> {
    const items: Array<{ label: readonly SnaptexAstNode[]; content: readonly SnaptexAstNode[] }> = [];
    let current: SnaptexAstNode[] | undefined;
    let currentLabel: readonly SnaptexAstNode[] = [];

    const pushCurrent = () => {
        if (!current) {
            return;
        }
        const content = trimAstLine(current);
        if (content.length > 0 || currentLabel.length > 0) {
            items.push({ label: currentLabel, content });
        }
    };

    stripLeadingEnvironmentOption(nodes).forEach(node => {
        if (isMacroNode(node) && TABLE_NOTE_LAYOUT_MACROS.has(node.content)) {
            return;
        }
        if (isMacroNode(node, 'item')) {
            pushCurrent();
            current = [];
            currentLabel = readNodeArgument(node, '[', 0)?.content ?? [];
            return;
        }
        if (current) {
            current.push(node);
        }
    });
    pushCurrent();
    return items;
}

function renderTableNotes(input: AstRenderInput, tablenotes: SnaptexAstNode | undefined): string {
    if (!tablenotes || !Array.isArray(tablenotes.content)) {
        return '';
    }

    const noteItems = splitTableNoteItems(tablenotes.content).map(item => {
        const labelHtml = item.label.length > 0
            ? `<strong>${input.renderChildren(item.label)}</strong> `
            : '';
        return `<li class="note-item" style="list-style:none">${labelHtml}${input.renderChildren(item.content).trim()}</li>`;
    }).join('');

    return noteItems ? `<div class="latex-tablenotes"><ul>${noteItems}</ul></div>` : '';
}

interface TableCell {
    html: string;
    colspan?: number;
    rowspan?: number;
}

function flushCell(rows: TableCell[][], cellNodes: SnaptexAstNode[], input: AstRenderInput) {
    rows[rows.length - 1].push(renderTableCell(cellNodes, input));
    cellNodes.length = 0;
}

function readRequiredContent(
    macro: SnaptexAstMacro,
    siblings: readonly SnaptexAstNode[],
    macroIndex: number,
    argumentIndex: number
): { content: readonly SnaptexAstNode[]; consumedNodes: number } {
    const attached = readRequiredMacroArgument(macro, argumentIndex);
    if (attached) {
        return { content: attached.content, consumedNodes: 1 };
    }

    let cursor = macroIndex + 1;
    for (let seen = 0; cursor < siblings.length; seen++) {
        cursor = skipWhitespaceOrComments(siblings, cursor);
        const group = siblings[cursor];
        if (!isGroupNode(group)) { break; }
        if (seen === argumentIndex) {
            return { content: group.content, consumedNodes: cursor - macroIndex + 1 };
        }
        cursor++;
    }
    return { content: [], consumedNodes: 1 };
}

function renderTableCell(cellNodes: readonly SnaptexAstNode[], input: AstRenderInput): TableCell {
    const significant = cellNodes.filter(node => !isWhitespaceOrCommentNode(node));
    const first = significant[0];
    const contentAt = (index: number) => isMacroNode(first)
        ? readRequiredContent(first, significant, 0, index).content
        : [];
    if (isMacroNode(first, 'multicolumn')) {
        return {
            colspan: Number.parseInt(astNodesToText(contentAt(0)), 10) || undefined,
            html: input.renderChildren(contentAt(2))
        };
    }
    if (isMacroNode(first, 'multirow')) {
        return {
            rowspan: Number.parseInt(astNodesToText(contentAt(0)), 10) || undefined,
            html: input.renderChildren(contentAt(2))
        };
    }
    if (isMacroNode(first, 'makecell')) {
        return {
            html: renderMakecell(input.renderChildren(contentAt(0)))
        };
    }
    return { html: input.renderChildren(cellNodes).trim() };
}

function renderMakecell(html: string): string {
    const lines = html.split(/<br\/?>|\\\\/).map(line => line.trim()).filter(Boolean);
    return renderLatexMakecellHtml(lines);
}

function skipParenthesizedTableModifier(nodes: readonly SnaptexAstNode[], index: number): number {
    let cursor = skipWhitespaceOrComments(nodes, index);
    if (stringNodeContent(nodes[cursor]) !== '(') {
        return index;
    }
    cursor++;
    while (cursor < nodes.length && stringNodeContent(nodes[cursor]) !== ')') {
        cursor++;
    }
    return cursor < nodes.length ? cursor + 1 : index;
}

function tableRuleConsumedNodes(nodes: readonly SnaptexAstNode[], index: number): number {
    const macro = nodes[index];
    if (!isMacroNode(macro)) {
        return 1;
    }

    let cursor = index + 1;
    if (macro.content === 'cmidrule') {
        cursor = skipParenthesizedTableModifier(nodes, cursor);
    }
    if (macro.content === 'cmidrule' || macro.content === 'cline') {
        cursor = skipWhitespaceOrComments(nodes, cursor);
        if (isGroupNode(nodes[cursor])) {
            cursor++;
        }
    }
    return Math.max(1, cursor - index);
}

function renderAstTabular(input: AstRenderInput, tabular: SnaptexAstNode): string {
    if (!Array.isArray(tabular.content)) {
        return '';
    }

    const rows: TableCell[][] = [[]];
    const cellNodes: SnaptexAstNode[] = [];
    let hasBooktabs = false;
    let hasRules = false;
    for (let index = 0; index < tabular.content.length; index++) {
        const node = tabular.content[index];
        if (node.type === 'string' && node.content === '&') {
            flushCell(rows, cellNodes, input);
            continue;
        }
        if (isMacroNode(node, '\\')) {
            flushCell(rows, cellNodes, input);
            rows.push([]);
            continue;
        }
        if (isMacroNode(node) && IGNORED_TABLE_MACROS.has(node.content)) {
            hasBooktabs = hasBooktabs || BOOKTABS_TABLE_MACROS.has(node.content);
            hasRules = hasRules || RULE_TABLE_MACROS.has(node.content);
            index += tableRuleConsumedNodes(tabular.content, index) - 1;
            continue;
        }
        cellNodes.push(node);
    }
    flushCell(rows, cellNodes, input);

    const activeRowspans: number[] = [];
    const rowHtml = rows
        .filter(row => row.some(cell => cell.html.trim().length > 0))
        .map(row => {
            const cells = renderTableRowCells(row, activeRowspans, cell => {
                const colspan = cell.colspan ?? 1;
                const rowspan = cell.rowspan ?? 1;
                const attrs = [
                    cell.colspan ? ` colspan="${cell.colspan}"` : '',
                    cell.rowspan ? ` rowspan="${cell.rowspan}"` : ''
                ].join('');
                return {
                    html: `<td${attrs}>${cell.html}</td>`,
                    colspan,
                    rowspan,
                    empty: !cell.html.trim()
                };
            });
            return `<tr>${cells}</tr>`;
        })
        .join('');
    const className = [
        'latex-tabular-preview',
        hasBooktabs ? 'latex-tabular-booktabs' : hasRules ? 'latex-tabular-ruled' : ''
    ].filter(Boolean).join(' ');
    return `<table class="${className}"><tbody>${rowHtml}</tbody></table>`;
}

function renderFigure(input: AstRenderInput): string {
    const content = stripLeadingEnvironmentOption(input.node.content as SnaptexAstNode[]);
    const caption = captionHtml(input, content, 'figure-caption', renderNumberedCaptionPrefix('Figure', 'fig'));
    const body = input.renderChildren(visibleFloatChildren(content, caption.nodes));
    const wrappedBody = body.includes('class="latex-subfigure"')
        ? `<div class="latex-subfigure-grid">${body}</div>`
        : body;
    return `<div class="latex-figure" style="text-align: center; margin: 1em 0;">${wrappedBody}${caption.html}</div>`;
}

function renderSubfigure(input: AstRenderInput): string {
    const rawContent = stripLeadingEnvironmentOption(input.node.content as SnaptexAstNode[]);
    const widthCursor = skipWhitespaceOrComments(rawContent, 0);
    const widthNode = rawContent[widthCursor];
    const widthSpec = isGroupNode(widthNode) ? astNodesToText(widthNode.content) : '';
    const content = isGroupNode(widthNode) ? rawContent.slice(widthCursor + 1) : rawContent;
    const caption = captionHtml(input, content, 'subfigure-caption', '(<span class="sn-cnt" data-type="subfig"></span>) ');
    const body = input.renderChildren(visibleFloatChildren(content, caption.nodes));
    return `<div class="latex-subfigure" style="${renderSubfigureWidthStyle(widthSpec)}">${body}${caption.html}</div>`;
}

function renderTable(input: AstRenderInput): string {
    const content = stripLeadingEnvironmentOption(input.node.content as SnaptexAstNode[]);
    const caption = captionHtml(input, content, 'table-caption', renderNumberedCaptionPrefix('Table', 'tbl'), true);
    const tabular = findFirstEnvironment(content, TABULAR_ENVS);
    const tablenotes = findFirstEnvironment(content, TABLENOTES_ENVS);
    const tableHtml = tabular ? renderAstTabular(input, tabular) : input.renderChildren(visibleFloatChildren(content, caption.nodes));
    return `<div class="latex-table">${caption.html}<div class="table-body">${tableHtml}</div>${renderTableNotes(input, tablenotes)}${tabular ? renderNestedLabels(input, content) : ''}</div>`;
}

function renderAlgorithmNodes(nodes: readonly SnaptexAstNode[], input: AstRenderInput): string {
    return nodes.map(node => {
        if (isMacroNode(node)) {
            const replacement = algorithmicInlineMacroHtml(node.content);
            if (replacement !== undefined) {
                return replacement;
            }
        }
        if (isGroupNode(node)) {
            return renderAlgorithmNodes(node.content, input);
        }
        return input.renderChildren([node]);
    }).join('');
}

function isLineBreakNode(node: SnaptexAstNode): boolean {
    const position = getSourcePosition(node);
    return node.type === 'parbreak'
        || (node.type === 'whitespace' && (
            (typeof node.content === 'string' && /\r|\n/.test(node.content))
            || (position !== undefined && position.end.line > position.start.line)
        ));
}

function trimAstLine(nodes: readonly SnaptexAstNode[]): SnaptexAstNode[] {
    let start = 0;
    let end = nodes.length;
    while (start < end && isWhitespaceOrCommentNode(nodes[start])) {
        start++;
    }
    while (end > start && isWhitespaceOrCommentNode(nodes[end - 1])) {
        end--;
    }
    return nodes.slice(start, end);
}

function splitAlgorithmicLines(nodes: readonly SnaptexAstNode[]): SnaptexAstNode[][] {
    const lines: SnaptexAstNode[][] = [];
    let current: SnaptexAstNode[] = [];
    for (const node of stripLeadingEnvironmentOption(nodes)) {
        if (isLineBreakNode(node)) {
            const line = trimAstLine(current);
            if (line.length > 0) {
                lines.push(line);
            }
            current = [];
        } else {
            current.push(node);
        }
    }
    const line = trimAstLine(current);
    if (line.length > 0) {
        lines.push(line);
    }
    return lines;
}

function renderAstAlgorithmic(input: AstRenderInput, context: AstRenderContext, algorithmic: SnaptexAstNode): string {
    if (!Array.isArray(algorithmic.content)) {
        return '';
    }

    const content = algorithmic.content;
    const optionNodes = stripLeadingEnvironmentOption(content);
    const showNumbers = optionNodes.length !== content.length && astNodesToText(content.slice(0, content.length - optionNodes.length)).includes('1');
    let indent = 0;
    const listItems = splitAlgorithmicLines(content).map(line => {
        const first = line[0];
        const descriptor = isMacroNode(first) ? describeAlgorithmicCommand(first.content) : undefined;
        let contentHtml = renderAlgorithmNodes(line, input);
        let prefix = '';

        if (descriptor && isMacroNode(first)) {
            const rest = line.slice(1);
            prefix = descriptor.label ? `<strong>${context.escapeHtml(descriptor.label)}</strong> ` : '';

            if (descriptor.consumesArgument) {
                const argument = readRequiredMacroArgument(first)?.content ?? [];
                const argumentHtml = argument.length > 0 ? renderAlgorithmNodes(argument, input) : renderAlgorithmNodes(rest, input);
                contentHtml = [descriptor.keyword ? context.escapeHtml(descriptor.keyword) : '', argumentHtml]
                    .filter(Boolean)
                    .join(' ');
            } else if (descriptor.keyword) {
                contentHtml = [context.escapeHtml(descriptor.keyword), renderAlgorithmNodes(rest, input)]
                    .filter(Boolean)
                    .join(' ');
            } else {
                contentHtml = renderAlgorithmNodes(rest, input);
            }
        }

        const lineIndent = algorithmicIndentBefore(indent, descriptor);
        indent = algorithmicIndentAfter(lineIndent, descriptor);
        return `<li ${algorithmicItemAttributes(lineIndent)}>${prefix}${contentHtml.trim()}</li>`;
    }).join('');
    const listTag = showNumbers ? 'ol' : 'ul';
    return `<${listTag} class="alg-list">${listItems}</${listTag}>`;
}

function renderAlgorithm(input: AstRenderInput, context: AstRenderContext): string {
    const content = stripLeadingEnvironmentOption(input.node.content as SnaptexAstNode[]);
    const caption = captionHtml(input, content, 'alg-caption', renderNumberedCaptionPrefix('Algorithm', 'alg'));
    const algorithmic = findFirstEnvironment(content, ALGORITHMIC_ENVS);
    const omitted = new Set(caption.nodes);
    if (algorithmic) {
        omitted.add(algorithmic);
    }
    const body = algorithmic
        ? renderAstAlgorithmic(input, context, algorithmic)
        : input.renderChildren(visibleFloatChildren(content, caption.nodes));
    const hidden = algorithmic ? input.renderChildren(visibleFloatChildren(content, omitted)) : '';
    return `<div class="latex-algorithm">${caption.html}${body}${hidden}<div class="alg-bottom-rule"></div></div>`;
}

export const AST_FLOAT_RULE: AstRenderRule = (input, context) => {
    if (!isEnvironmentNode(input.node) || !Array.isArray(input.node.content)) {
        return undefined;
    }

    const envName = environmentName(input.node) ?? '';
    if (!FLOATS.has(envName)) { return undefined; }
    if (envName.startsWith('figure')) {
        return { html: renderFigure(input) };
    }
    if (envName.startsWith('table')) {
        return { html: renderTable(input) };
    }
    return { html: renderAlgorithm(input, context) };
};

export const AST_SUBFIGURE_RULE: AstRenderRule = input => {
    if (!isEnvironmentNode(input.node)
        || !SUBFIGURE_ENVS.has(environmentName(input.node) ?? '')
        || !Array.isArray(input.node.content)) {
        return undefined;
    }
    return { html: renderSubfigure(input) };
};

export const AST_TABULAR_RULE: AstRenderRule = input =>
    isEnvironmentNode(input.node) && TABULAR_ENVS.has(environmentName(input.node) ?? '')
        ? { html: renderAstTabular(input, input.node) }
        : undefined;

export const AST_TABLE_MACRO_RULE: AstRenderRule = input => {
    if (!isMacroNode(input.node) || !TABLE_CELL_MACROS.has(input.node.content)) {
        return undefined;
    }
    if (input.node.content === 'tnote') {
        const marker = readRequiredContent(input.node, input.siblings, input.index, 0);
        return {
            html: `<sup class="latex-tnote">${input.renderChildren(marker.content)}</sup>`,
            consumedNodes: marker.consumedNodes
        };
    }
    const contentIndex = input.node.content === 'multicolumn' || input.node.content === 'multirow' ? 2 : 0;
    const content = readRequiredContent(input.node, input.siblings, input.index, contentIndex);
    const html = input.renderChildren(content.content);
    return {
        html: input.node.content === 'makecell' ? renderMakecell(html) : `<span>${html}</span>`,
        consumedNodes: content.consumedNodes
    };
};
