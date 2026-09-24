import type { SnaptexAstNode } from '../types';
import {
    astNodesToLatex,
    astNodesToText,
    environmentName,
    findAstNode,
    getSourcePosition,
    isCommentNode,
    isGroupNode,
    isEnvironmentNode,
    isMacroNode,
    isWhitespaceOrCommentNode,
    readBracketNodes,
    readNodeArgument,
    readRequiredMacroArgument,
    skipWhitespaceOrComments,
    stringNodeContent
} from '../visit-utils';
import { readAstCommandNodeArguments, type AstRenderContext, type AstRenderInput, type AstRenderRule } from './index';
import {
    algorithmicIndentAfter,
    algorithmicIndentBefore,
    algorithmicInlineMacroHtml,
    algorithmicItemAttributes,
    describeAlgorithmicCommand,
    isAlgorithm2eSource,
    renderAlgorithm2eList
} from '../../latex-algorithm';
import { renderLatexMakecellHtml, renderTableRowCells } from '../../latex-table';
import { SUBCAPTIONBOX_ARGUMENT_ORDER, SUBFIGURE_MACRO_COMMANDS } from '../../patterns';
import { renderCaptionHtml, renderNumberedCaptionPrefix, renderSubfigureHtml } from '../../rule-helpers';
import { expandLatexTextMacros, extractAndHideLabels } from '../../utils';

const FLOATS = new Set(['figure', 'figure*', 'table', 'table*', 'algorithm']);
const SUBFIGURE_ENVS = new Set(['subfigure', 'subfigure*']);
const TABULAR_ENVS = new Set(['tabular', 'tabular*', 'tabularx', 'longtable']);
const TABLENOTES_ENVS = new Set(['tablenotes']);
const ALGORITHMIC_ENVS = new Set(['algorithmic']);
const BOOKTABS_TABLE_MACROS = new Set(['toprule', 'midrule', 'bottomrule', 'cmidrule']);
const RULE_TABLE_MACROS = new Set(['hline', 'hhline', 'cline']);
const IGNORED_TABLE_MACROS = new Set([...BOOKTABS_TABLE_MACROS, ...RULE_TABLE_MACROS]);
const TABLE_NOTE_LAYOUT_MACROS = new Set(['footnotesize', 'small', 'scriptsize', 'tiny']);
const FLOAT_LAYOUT_MACROS = new Set(['centering', 'hfill', 'small', 'footnotesize']);
const TABLE_CELL_MACROS = new Set(['multicolumn', 'multirow', 'makecell', 'tnote']);
const LONGTABLE_LAYOUT_MACROS = new Set(['endfirsthead', 'endhead', 'endfoot', 'endlastfoot']);

interface AstCaption {
    content: readonly SnaptexAstNode[];
    starred: boolean;
    nodes: readonly SnaptexAstNode[];
}

function collectCaptions(nodes: readonly SnaptexAstNode[], searchNested: boolean): AstCaption[] {
    const captions: AstCaption[] = [];
    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        if (isMacroNode(node, 'caption')) {
            const attached = readRequiredMacroArgument(node)?.content ?? [];
            const starred = astNodesToText(attached).trim() === '*';
            const detachedIndex = starred ? skipWhitespaceOrComments(nodes, index + 1) : -1;
            const detached = detachedIndex >= 0 && isGroupNode(nodes[detachedIndex]) ? nodes[detachedIndex] : undefined;
            captions.push({
                content: detached?.content ?? attached,
                starred,
                nodes: detached ? [node, detached] : [node]
            });
        }
        if (searchNested && Array.isArray(node.content)
            && !SUBFIGURE_ENVS.has(environmentName(node) ?? '')) {
            captions.push(...collectCaptions(node.content, true));
        }
    }
    return captions;
}

function captionHtml(
    input: AstRenderInput,
    contentNodes: readonly SnaptexAstNode[],
    className: string,
    prefixHtml: string,
    searchNested = false
): { html: string; nodes: Set<SnaptexAstNode> } {
    const captions = collectCaptions(contentNodes, searchNested);
    const nodes = new Set(captions.flatMap(caption => caption.nodes));
    return {
        html: captions.map(caption => renderCaptionHtml(
            className,
            input.renderChildren(caption.content),
            caption.starred ? '' : prefixHtml
        )).join(''),
        nodes
    };
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
        visible.push(Array.isArray(node.content)
            ? { ...node, content: removeNestedNodes(node.content, omitted) }
            : node);
    }
    return visible;
}

function removeNestedNodes(nodes: readonly SnaptexAstNode[], omitted: Set<SnaptexAstNode>): SnaptexAstNode[] {
    return nodes.flatMap(node => omitted.has(node)
        ? []
        : [{ ...node, ...(Array.isArray(node.content) ? { content: removeNestedNodes(node.content, omitted) } : {}) }]);
}

function stripLeadingEnvironmentOption(nodes: readonly SnaptexAstNode[]): SnaptexAstNode[] {
    const bracket = readBracketNodes(nodes, skipWhitespaceOrComments(nodes, 0));
    return bracket ? nodes.slice(bracket.nextIndex) : [...nodes];
}

function findFirstEnvironment(nodes: readonly SnaptexAstNode[], envs: ReadonlySet<string>): SnaptexAstNode | undefined {
    return findAstNode(nodes, node => {
        const envName = environmentName(node);
        return envName !== undefined && envs.has(envName);
    });
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

function renderTableCell(cellNodes: readonly SnaptexAstNode[], input: AstRenderInput): TableCell {
    const significant = cellNodes.filter(node => !isWhitespaceOrCommentNode(node));
    const first = significant[0];
    const args = isMacroNode(first)
        ? readAstCommandNodeArguments({ ...input, node: first, siblings: significant, index: 0 }, 3).requiredArgs
        : [];
    const contentAt = (index: number) => args[index] ?? [];
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
    if (macro.content === 'cmidrule' || macro.content === 'cline' || macro.content === 'hhline') {
        cursor = skipWhitespaceOrComments(nodes, cursor);
        if (isGroupNode(nodes[cursor])) {
            cursor++;
        }
    }
    return Math.max(1, cursor - index);
}

function renderAstTabular(input: AstRenderInput, tabular: SnaptexAstNode, omitted?: ReadonlySet<SnaptexAstNode>): string {
    if (!Array.isArray(tabular.content)) {
        return '';
    }

    const envName = environmentName(tabular);
    const argumentCount = envName === 'tabularx' || envName === 'tabular*' ? 2 : 1;
    const optionalArgument = readBracketNodes(tabular.content, skipWhitespaceOrComments(tabular.content, 0));
    let bodyStart = optionalArgument?.nextIndex ?? 0;
    for (let argument = 0; argument < argumentCount; argument++) {
        bodyStart = skipWhitespaceOrComments(tabular.content, bodyStart);
        if (!isGroupNode(tabular.content[bodyStart])) { break; }
        bodyStart++;
    }

    const rows: TableCell[][] = [[]];
    const cellNodes: SnaptexAstNode[] = [];
    let hasBooktabs = false;
    let hasRules = false;
    for (let index = bodyStart; index < tabular.content.length; index++) {
        const node = tabular.content[index];
        if (omitted?.has(node) || (isMacroNode(node) && LONGTABLE_LAYOUT_MACROS.has(node.content))) {
            continue;
        }
        if (node.type === 'string' && node.content === '&') {
            flushCell(rows, cellNodes, input);
            continue;
        }
        if (isMacroNode(node) && (node.content === '\\' || node.content === 'tabularnewline')) {
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
    const caption = captionHtml(input, content, 'figure-caption', renderNumberedCaptionPrefix('Figure', 'fig'), true);
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
    return renderSubfigureHtml(body, caption.html, widthSpec);
}

function renderSubfigureMacro(input: AstRenderInput): { html: string; consumedNodes: number } | undefined {
    if (!isMacroNode(input.node) || ![...SUBFIGURE_MACRO_COMMANDS, 'subcaptionbox'].includes(input.node.content)) {
        return undefined;
    }
    const subcaptionBox = input.node.content === 'subcaptionbox';
    const args = readAstCommandNodeArguments(
        input,
        subcaptionBox ? 2 : 1,
        subcaptionBox ? SUBCAPTIONBOX_ARGUMENT_ORDER : undefined
    );
    const caption = subcaptionBox ? args.requiredArgs[0] : args.optionalArgs[0];
    const body = args.requiredArgs[subcaptionBox ? 1 : 0];
    if (!body) { return undefined; }

    const captionHtml = caption && caption.length > 0
        ? renderCaptionHtml(
            'subfigure-caption',
            input.renderChildren(caption),
            '(<span class="sn-cnt" data-type="subfig"></span>) '
        )
        : '';
    const widthSpec = subcaptionBox && args.optionalArgs[0]
        ? astNodesToLatex(args.optionalArgs[0])
        : '0.48\\textwidth';
    return {
        html: renderSubfigureHtml(input.renderChildren(body), captionHtml, widthSpec),
        consumedNodes: args.consumedNodes
    };
}

function renderCaptionOfMacro(input: AstRenderInput) {
    if (!isMacroNode(input.node, 'captionof')) { return undefined; }
    const args = readAstCommandNodeArguments(input, 2);
    const type = astNodesToText(args.requiredArgs[0] ?? []).trim().toLowerCase();
    const knownType = type === 'table' ? 'table' : type === 'figure' ? 'figure' : undefined;
    return {
        html: renderCaptionHtml(
            knownType ? `${knownType}-caption` : 'latex-caption',
            input.renderChildren(args.requiredArgs[1] ?? []),
            knownType ? renderNumberedCaptionPrefix(knownType === 'table' ? 'Table' : 'Figure', knownType === 'table' ? 'tbl' : 'fig') : ''
        ),
        consumedNodes: args.consumedNodes
    };
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
    let html = '';
    let start = 0;
    let consumedThrough = -1;
    nodes.forEach((node, index) => {
        if (index <= consumedThrough) { return; }
        if (isMacroNode(node) && /^comment$/i.test(node.content)) {
            const attached = readRequiredMacroArgument(node)?.content;
            const siblingNode = nodes[index + 1];
            const sibling = isGroupNode(siblingNode) && Array.isArray(siblingNode.content) ? siblingNode.content : undefined;
            const argument = attached?.length ? attached : sibling ?? [];
            html += input.renderChildren(nodes.slice(start, index));
            html += `<em>(${renderAlgorithmNodes(argument, input)})</em>`;
            consumedThrough = sibling && !attached?.length ? index + 1 : index;
            start = consumedThrough + 1;
            return;
        }
        const replacement = isMacroNode(node) ? algorithmicInlineMacroHtml(node.content) : undefined;
        if (replacement === undefined && !isGroupNode(node)) { return; }
        html += input.renderChildren(nodes.slice(start, index));
        html += isGroupNode(node) ? renderAlgorithmNodes(node.content, input) : replacement;
        start = index + 1;
    });
    return html + input.renderChildren(nodes.slice(start));
}

function isLineBreakNode(node: SnaptexAstNode): boolean {
    const position = getSourcePosition(node);
    return node.type === 'parbreak' || isCommentNode(node)
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
        const descriptor = isMacroNode(first) ? describeAlgorithmicCommand(first.content, context.metadata?.macros) : undefined;
        let contentHtml: string;
        let prefix = '';

        if (descriptor && isMacroNode(first)) {
            const rest = line.slice(1);
            prefix = descriptor.label ? `<strong>${context.escapeHtml(descriptor.label)}</strong> `
                : descriptor.labelSource ? `${input.renderSource(descriptor.labelSource)} ` : '';

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
        } else {
            contentHtml = renderAlgorithmNodes(line, input);
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
    const caption = captionHtml(input, content, 'alg-caption', renderNumberedCaptionPrefix('Algorithm', 'alg'), true);
    const algorithmic = findFirstEnvironment(content, ALGORITHMIC_ENVS);
    const omitted = new Set(caption.nodes);
    if (algorithmic) {
        omitted.add(algorithmic);
    }
    const visibleContent = visibleFloatChildren(content, caption.nodes);
    const topLevelLabels = new Set<SnaptexAstNode>(visibleContent.filter(node => isMacroNode(node, 'label')));
    const source = expandLatexTextMacros(
        astNodesToLatex(visibleContent.filter(node => !topLevelLabels.has(node))),
        context.metadata?.macros ?? {}
    );
    const extractedSource = extractAndHideLabels(source);
    const body = algorithmic
        ? renderAstAlgorithmic(input, context, algorithmic)
        : isAlgorithm2eSource(extractedSource.cleanContent)
            ? renderAlgorithm2eList(extractedSource.cleanContent, input.renderSource)
            : input.renderChildren(visibleContent);
    const hidden = algorithmic
        ? input.renderChildren(visibleFloatChildren(content, omitted))
        : input.renderChildren([...topLevelLabels]) + extractedSource.hiddenHtml;
    return `<div class="latex-algorithm">${caption.html}${body}${hidden}<div class="alg-bottom-rule"></div></div>`;
}

export const AST_FLOAT_RULE: AstRenderRule = (input, context) => {
    const captionOf = renderCaptionOfMacro(input);
    if (captionOf) { return captionOf; }
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
    const macro = renderSubfigureMacro(input);
    if (macro) { return macro; }
    if (!isEnvironmentNode(input.node)
        || !SUBFIGURE_ENVS.has(environmentName(input.node) ?? '')
        || !Array.isArray(input.node.content)) {
        return undefined;
    }
    return { html: renderSubfigure(input) };
};

export const AST_TABULAR_RULE: AstRenderRule = input => {
    const envName = environmentName(input.node) ?? '';
    if (!isEnvironmentNode(input.node) || !TABULAR_ENVS.has(envName)) {
        return undefined;
    }
    if (envName !== 'longtable' || !Array.isArray(input.node.content)) {
        return { html: renderAstTabular(input, input.node) };
    }

    const caption = captionHtml(input, input.node.content, 'table-caption', renderNumberedCaptionPrefix('Table', 'tbl'));
    return { html: `<div class="latex-table">${caption.html}<div class="table-body">${renderAstTabular(input, input.node, caption.nodes)}</div></div>` };
};

export const AST_TABLE_MACRO_RULE: AstRenderRule = input => {
    if (!isMacroNode(input.node) || !TABLE_CELL_MACROS.has(input.node.content)) {
        return undefined;
    }
    if (input.node.content === 'tnote') {
        const marker = readAstCommandNodeArguments(input);
        return {
            html: `<sup class="latex-tnote">${input.renderChildren(marker.requiredArgs[0] ?? [])}</sup>`,
            consumedNodes: marker.consumedNodes
        };
    }
    const contentIndex = input.node.content === 'multicolumn' || input.node.content === 'multirow' ? 2 : 0;
    const args = readAstCommandNodeArguments(input, contentIndex + 1);
    const html = input.renderChildren(args.requiredArgs[contentIndex] ?? []);
    return {
        html: input.node.content === 'makecell' ? renderMakecell(html) : `<span>${html}</span>`,
        consumedNodes: args.consumedNodes
    };
};
