import { RenderContext } from './types';
import { readLatexCommandAt, readLatexGroup, replaceLatexCommandCalls, resolveLatexStyles, type LatexGroup } from './utils';
import { renderMath } from './rule-helpers';

type TableRuleKind = 'top' | 'mid' | 'bottom' | 'hline';

interface LatexTableRow {
    cells: string[];
    rulesBefore: TableRuleKind[];
}

interface LatexTableModel {
    rows: LatexTableRow[];
    hasBooktabs: boolean;
    hasRules: boolean;
}

interface TabularEnvironment {
    beginStart: number;
    bodyStart: number;
    bodyEnd: number;
    end: number;
    columnSpec: string;
}

interface RenderedLatexTableCell {
    html: string;
    colspan: number;
    rowspan: number;
}

interface TableBoundary {
    kind: 'row' | 'rule';
    rule?: TableRuleKind;
    end: number;
}

interface TableScanStep {
    text: string;
    end: number;
    depthBefore: number;
    depthAfter: number;
}

const TABULAR_ENV_REGEX = /\\begin\{(tabular\*?|tabularx)\}/g;

function readTableCommandGroups(text: string, commandName: string, groupCount: number): LatexGroup[] | undefined {
    return readLatexCommandAt(text, 0, {
        name: commandName,
        requiredArgs: groupCount,
        optionalArgs: 1,
        skipWhitespace: false
    })?.requiredArgs;
}

function findMatchingTabularEnd(text: string, envName: string, bodyStart: number): { start: number; end: number } | undefined {
    const envRegex = /\\(begin|end)\{(tabular\*?|tabularx)\}/g;
    envRegex.lastIndex = bodyStart;
    let depth = 1;
    let match: RegExpExecArray | null;

    while ((match = envRegex.exec(text)) !== null) {
        if (match[2] !== envName) { continue; }

        if (match[1] === 'begin') {
            depth++;
        } else {
            depth--;
            if (depth === 0) {
                return { start: match.index, end: match.index + match[0].length };
            }
        }
    }

    return undefined;
}

function readTabularEnvironmentAt(text: string, beginStart: number): TabularEnvironment | undefined {
    const beginMatch = /^\\begin\{(tabular\*?|tabularx)\}/.exec(text.substring(beginStart));
    if (!beginMatch) { return undefined; }

    const envName = beginMatch[1];
    const args: string[] = [];
    let index = beginStart + beginMatch[0].length;
    const requiredArgs = envName === 'tabular' ? 1 : 2;

    while (args.length < requiredArgs) {
        const optionalGroup = readLatexGroup(text, index, { delimiter: 'bracket' });
        if (optionalGroup) {
            index = optionalGroup.end;
            continue;
        }

        const group = readLatexGroup(text, index);
        if (!group) { return undefined; }
        args.push(group.content);
        index = group.end;
    }

    const endMatch = findMatchingTabularEnd(text, envName, index);
    if (!endMatch) { return undefined; }

    return {
        beginStart,
        bodyStart: index,
        bodyEnd: endMatch.start,
        end: endMatch.end,
        columnSpec: args[args.length - 1] ?? ''
    };
}

export function findFirstTabularEnvironment(text: string): TabularEnvironment | undefined {
    TABULAR_ENV_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = TABULAR_ENV_REGEX.exec(text)) !== null) {
        const tabular = readTabularEnvironmentAt(text, match.index);
        if (tabular) { return tabular; }
    }

    return undefined;
}

function classifyTableRule(token: string): TableRuleKind | undefined {
    if (token.startsWith('\\toprule')) { return 'top'; }
    if (token.startsWith('\\midrule') || token.startsWith('\\cmidrule')) { return 'mid'; }
    if (token.startsWith('\\bottomrule')) { return 'bottom'; }
    if (token.startsWith('\\hline')) { return 'hline'; }
    return undefined;
}

function matchTableBoundaryAt(text: string, index: number): TableBoundary | undefined {
    const slice = text.substring(index);
    const rowMatch = /^\\\\(?:\[.*?\])?/.exec(slice);
    if (rowMatch) {
        return { kind: 'row', end: index + rowMatch[0].length };
    }

    const ruleMatch = /^(\\toprule(?:\[.*?\])?|\\midrule(?:\[.*?\])?|\\bottomrule(?:\[.*?\])?|\\cmidrule(?:\[.*?\])?(?:\(.*?\))?\{[^}]+\}|\\hline)/.exec(slice);
    if (ruleMatch) {
        return {
            kind: 'rule',
            rule: classifyTableRule(ruleMatch[0]),
            end: index + ruleMatch[0].length
        };
    }

    return undefined;
}

function readTableScanStep(text: string, index: number, depth: number): TableScanStep {
    const nested = readTabularEnvironmentAt(text, index);
    if (nested) {
        return {
            text: text.substring(index, nested.end),
            end: nested.end,
            depthBefore: depth,
            depthAfter: depth
        };
    }

    const char = text[index];
    if (char === '\\') {
        const end = Math.min(text.length, index + 2);
        return {
            text: text.substring(index, end),
            end,
            depthBefore: depth,
            depthAfter: depth
        };
    }

    let depthAfter = depth;
    if (char === '{') {
        depthAfter++;
    } else if (char === '}') {
        depthAfter = Math.max(0, depthAfter - 1);
    }

    return {
        text: char,
        end: index + 1,
        depthBefore: depth,
        depthAfter
    };
}

function splitLatexTopLevel(content: string, separator: string): string[] {
    const parts: string[] = [];
    let current = '';
    let depth = 0;

    for (let i = 0; i < content.length;) {
        const step = readTableScanStep(content, i, depth);
        if (step.text === separator && step.depthBefore === 0) {
            parts.push(current.trim());
            current = '';
        } else {
            current += step.text;
        }
        depth = step.depthAfter;
        i = step.end;
    }

    parts.push(current.trim());
    return parts;
}

function splitLatexTableCells(rowText: string): string[] {
    return splitLatexTopLevel(rowText, '&');
}

function parseLatexTableRows(rawContent: string): LatexTableModel {
    const tableContent = normalizeLatexTableBody(rawContent);
    const rows: LatexTableRow[] = [];
    const pendingRules: TableRuleKind[] = [];
    let hasBooktabs = false;
    let hasRules = false;
    let current = '';
    let depth = 0;

    const pushRow = () => {
        const trimmed = current.trim();
        if (trimmed) {
            rows.push({
                cells: splitLatexTableCells(trimmed),
                rulesBefore: pendingRules.splice(0)
            });
        }
        current = '';
    };

    for (let i = 0; i < tableContent.length;) {
        const boundary = depth === 0 ? matchTableBoundaryAt(tableContent, i) : undefined;
        if (boundary) {
            if (boundary.kind === 'row') {
                pushRow();
            } else {
                if (current.trim()) {
                    pushRow();
                }
                if (boundary.rule) {
                    hasRules = true;
                    hasBooktabs ||= boundary.rule === 'top' || boundary.rule === 'mid' || boundary.rule === 'bottom';
                    pendingRules.push(boundary.rule);
                }
            }
            i = boundary.end;
            continue;
        }

        const step = readTableScanStep(tableContent, i, depth);
        current += step.text;
        depth = step.depthAfter;
        i = step.end;
    }

    if (current.trim()) {
        pushRow();
    }

    return { rows, hasBooktabs, hasRules };
}

function normalizeLatexTableBody(rawContent: string): string {
    return stripLatexTablePresentationCommands(rawContent)
        .replace(/\\cline\{[^}]+\}/g, '\\hline')
        .replace(/\\addlinespace(?:\[.*?\])?/g, '')
        .replace(/\\vspace\*?\{[^}]+\}/g, '')
        .replace(/\\setlength\s*\\[a-zA-Z]+\s*\{[^}]+\}/g, '');
}

function cleanLatexTableCell(text: string): string {
    return stripLatexTablePresentationCommands(text).trim();
}

function stripLatexTablePresentationCommands(text: string): string {
    return text
        .replace(/\\(?:centering|raggedright|raggedleft|arraybackslash)\b/g, '')
        .replace(/\\(?:small|footnotesize|scriptsize|tiny|normalsize)\b/g, '');
}

function stripLatexGroupingBraces(text: string): string {
    const openBrace = '\uE000';
    const closeBrace = '\uE001';
    return text
        .replace(/\\\{/g, openBrace)
        .replace(/\\\}/g, closeBrace)
        .replace(/\{([^{}]*)\}/g, '$1')
        .replace(new RegExp(openBrace, 'g'), '{')
        .replace(new RegExp(closeBrace, 'g'), '}');
}

function readColumnModifierGroups(columnSpec: string): { before: string[]; after: string[] } {
    const groups = { before: [] as string[], after: [] as string[] };

    for (let i = 0; i < columnSpec.length; i++) {
        const marker = columnSpec[i];
        if ((marker !== '>' && marker !== '<') || columnSpec[i + 1] !== '{') {
            continue;
        }

        const group = readLatexGroup(columnSpec, i + 1);
        if (!group) {
            continue;
        }

        groups[marker === '>' ? 'before' : 'after'].push(group.content);
        i = group.end - 1;
    }

    return groups;
}

function isMathModeColumnModifier(content: string): boolean {
    const compact = content.replace(/\s+/g, '');
    return compact === '$' || compact === '\\$' || /^XSNAP:math:\d+Y$/.test(compact);
}

function tabularColumnSpecUsesMathMode(columnSpec: string): boolean {
    const groups = readColumnModifierGroups(columnSpec);
    const hasMathBefore = groups.before.some(isMathModeColumnModifier);
    const hasMathAfter = groups.after.some(isMathModeColumnModifier);

    if (hasMathBefore && hasMathAfter) {
        return true;
    }

    return groups.before.some(group => /XSNAP:math:\d+Y/.test(group));
}

function splitLatexLineBreaks(content: string): string[] {
    return splitLatexTopLevel(content, '\\\\').filter(line => line.length > 0);
}

function renderTableInlineCommands(content: string, renderer: RenderContext): string {
    return replaceLatexCommandCalls(content, [
        {
            name: 'makecell',
            requiredArgs: 1,
            optionalArgs: 1,
            render: call => {
                const lines = splitLatexLineBreaks(call.requiredArgs[0].content);
                const lineHtml = lines.map(line => {
                    return `<span class="latex-makecell-line">${renderLatexTableInlineContent(line, renderer)}</span>`;
                }).join('');
                return renderer.protectHtml('makecell', `<span class="latex-makecell">${lineHtml}</span>`);
            }
        },
        {
            name: 'tnote',
            requiredArgs: 1,
            render: call => {
                const markerHtml = renderLatexTableInlineContent(call.requiredArgs[0].content, renderer);
                return renderer.protectHtml('tnote', `<sup class="latex-tnote">${markerHtml}</sup>`);
            }
        }
    ]);
}

export function renderLatexTableInlineContent(content: string, renderer: RenderContext): string {
    const withNestedTables = renderNestedTabulars(cleanLatexTableCell(content), renderer);
    const withTableCommands = renderTableInlineCommands(withNestedTables, renderer);
    const withMath = withTableCommands.replace(/\$((?:\\.|[^\\$])+?)\$/g, (_match: string, tex: string) => {
        return renderMath(tex.trim(), false, renderer);
    });
    const withSpaces = withMath.replace(/~/g, () => renderer.protectHtml('space', '&nbsp;'));
    const styledContent = resolveLatexStyles(withSpaces, html => renderer.protectHtml('style', html));
    return renderer.renderInline(stripLatexGroupingBraces(styledContent));
}

function renderNestedMathCell(content: string, renderer: RenderContext): string {
    const tex = cleanLatexTableCell(content).replace(/~+/g, '\\quad ');
    return renderMath(tex, false, renderer);
}

function renderNestedTabular(tabular: TabularEnvironment, source: string, renderer: RenderContext): string {
    const body = tabular.bodyStart < tabular.bodyEnd ? source.substring(tabular.bodyStart, tabular.bodyEnd) : '';
    const model = parseLatexTableRows(body);
    const mathMode = tabularColumnSpecUsesMathMode(tabular.columnSpec);
    const className = `latex-nested-tabular${mathMode ? ' latex-nested-tabular-math' : ''}`;
    const rowsHtml = model.rows.map(row => {
        const cells = row.cells.map(cell => {
            const html = mathMode ? renderNestedMathCell(cell, renderer) : renderLatexTableInlineContent(cell, renderer);
            return `<span class="latex-nested-tabular-cell">${html}</span>`;
        }).join('');
        return `<div class="latex-nested-tabular-row">${cells}</div>`;
    }).join('');

    return `<div class="${className}">${rowsHtml}</div>`;
}

function renderNestedTabulars(content: string, renderer: RenderContext): string {
    let result = '';
    let index = 0;

    while (index < content.length) {
        const beginIndex = content.indexOf('\\begin{tabular', index);
        if (beginIndex === -1) {
            result += content.substring(index);
            break;
        }

        result += content.substring(index, beginIndex);
        const nested = readTabularEnvironmentAt(content, beginIndex);
        if (!nested) {
            result += content.substring(beginIndex, beginIndex + '\\begin{tabular'.length);
            index = beginIndex + '\\begin{tabular'.length;
            continue;
        }

        result += renderer.protectHtml('nested-table', renderNestedTabular(nested, content, renderer));
        index = nested.end;
    }

    return result;
}

function renderLatexTableCell(cellText: string, renderer: RenderContext, tagName: 'td' | 'th'): RenderedLatexTableCell {
    let content = cellText.trim();
    let colspan = 1;
    let rowspan = 1;
    const attrs: string[] = [];
    const classes: string[] = [];

    const multirowGroups = readTableCommandGroups(content, 'multirow', 3);
    if (multirowGroups) {
        const parsedRowspan = Number.parseInt(multirowGroups[0].content, 10);
        if (Number.isFinite(parsedRowspan) && Math.abs(parsedRowspan) > 1) {
            rowspan = Math.abs(parsedRowspan);
            attrs.push(`rowspan="${rowspan}"`);
        }
        content = multirowGroups[2].content;
    }

    if (content.startsWith('\\multicolumn')) {
        const multicolumnGroups = readTableCommandGroups(content, 'multicolumn', 3);
        if (multicolumnGroups) {
            const parsedColspan = Number.parseInt(multicolumnGroups[0].content, 10);
            content = multicolumnGroups[2].content;
            if (Number.isFinite(parsedColspan) && parsedColspan > 1) {
                colspan = parsedColspan;
                attrs.push(`colspan="${colspan}"`);
            }

            const alignSpec = multicolumnGroups[1].content;
            const align = alignSpec.includes('r') ? 'right' : alignSpec.includes('c') ? 'center' : 'left';
            classes.push(`table-cell-align-${align}`);
        }
    }

    if (tagName === 'th') {
        attrs.unshift('scope="col"');
    }
    if (classes.length > 0) {
        attrs.push(`class="${classes.join(' ')}"`);
    }

    const htmlContent = renderLatexTableInlineContent(content, renderer);
    const attrText = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
    return {
        html: `<${tagName}${attrText}>${htmlContent}</${tagName}>`,
        colspan,
        rowspan
    };
}

function renderLatexTableRows(rows: LatexTableRow[], renderer: RenderContext, tagName: 'td' | 'th', suppressFirstRule: boolean): string {
    const activeRowspans: number[] = [];

    return rows.map((row, rowIndex) => {
        const hasRuleAbove = row.rulesBefore.some(rule => rule === 'mid' || rule === 'hline') && !(suppressFirstRule && rowIndex === 0);
        const classAttr = hasRuleAbove ? ' class="table-row-rule-above"' : '';
        const renderedCells: string[] = [];
        let columnIndex = 0;

        cellLoop:
        for (const cell of row.cells) {
            while ((activeRowspans[columnIndex] ?? 0) > 0) {
                activeRowspans[columnIndex]--;
                columnIndex++;
                if (!cell.trim()) {
                    continue cellLoop;
                }
            }

            const rendered = renderLatexTableCell(cell, renderer, tagName);
            renderedCells.push(rendered.html);
            if (rendered.rowspan > 1) {
                for (let offset = 0; offset < rendered.colspan; offset++) {
                    activeRowspans[columnIndex + offset] = Math.max(activeRowspans[columnIndex + offset] ?? 0, rendered.rowspan - 1);
                }
            }
            columnIndex += rendered.colspan;
        }

        return `<tr${classAttr}>${renderedCells.join('')}</tr>`;
    }).join('');
}

export function renderLatexTabular(rawContent: string, renderer: RenderContext): string {
    const model = parseLatexTableRows(rawContent);
    if (model.rows.length === 0) { return ''; }

    const firstBodyRowIndex = model.rows.findIndex((row, index) => index > 0 && row.rulesBefore.some(rule => rule === 'mid' || rule === 'hline'));
    const hasHeader = firstBodyRowIndex > 0;
    const headerRows = hasHeader ? model.rows.slice(0, firstBodyRowIndex) : [];
    const bodyRows = hasHeader ? model.rows.slice(firstBodyRowIndex) : model.rows;
    const classNames = ['latex-tabular-preview', model.hasBooktabs ? 'latex-tabular-booktabs' : model.hasRules ? 'latex-tabular-ruled' : ''];

    const theadHtml = hasHeader ? `<thead>${renderLatexTableRows(headerRows, renderer, 'th', true)}</thead>` : '';
    const tbodyHtml = `<tbody>${renderLatexTableRows(bodyRows, renderer, 'td', hasHeader)}</tbody>`;
    return `<table class="${classNames.filter(Boolean).join(' ')}">${theadHtml}${tbodyHtml}</table>`;
}
