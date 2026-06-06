import { RenderContext } from './types';
import { findBalancedClosingBrace, resolveLatexStyles } from './utils';
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

interface LatexGroup {
    content: string;
    end: number;
}

export interface TabularEnvironment {
    envName: string;
    beginStart: number;
    bodyStart: number;
    bodyEnd: number;
    end: number;
    args: string[];
    columnSpec: string;
}

interface RenderedLatexTableCell {
    html: string;
    colspan: number;
    rowspan: number;
    isEmpty: boolean;
}

interface TableBoundary {
    kind: 'row' | 'rule';
    rule?: TableRuleKind;
    end: number;
}

const TABULAR_ENV_REGEX = /\\begin\{(tabular\*?|tabularx)\}/g;

function readLatexGroup(text: string, startIndex: number): LatexGroup | undefined {
    let index = skipWhitespace(text, startIndex);
    if (text[index] !== '{') { return undefined; }

    const closeIndex = findBalancedClosingBrace(text, index);
    if (closeIndex === -1) { return undefined; }

    return {
        content: text.substring(index + 1, closeIndex),
        end: closeIndex + 1
    };
}

function skipWhitespace(text: string, index: number): number {
    while (index < text.length && /\s/.test(text[index])) { index++; }
    return index;
}

function skipOptionalBracket(text: string, startIndex: number): number {
    const index = skipWhitespace(text, startIndex);
    if (text[index] !== '[') { return startIndex; }

    let depth = 1;
    for (let i = index + 1; i < text.length; i++) {
        const char = text[i];
        if (char === '\\') {
            i++;
            continue;
        }
        if (char === '[') {
            depth++;
        } else if (char === ']') {
            depth--;
            if (depth === 0) {
                return i + 1;
            }
        }
    }

    return startIndex;
}

function readCommandGroups(text: string, commandName: string, groupCount: number): LatexGroup[] | undefined {
    if (!text.startsWith(`\\${commandName}`)) { return undefined; }

    const groups: LatexGroup[] = [];
    let index = `\\${commandName}`.length;
    const skippedOptional = skipOptionalBracket(text, index);
    if (skippedOptional !== index) {
        index = skippedOptional;
    }

    while (groups.length < groupCount) {
        const group = readLatexGroup(text, index);
        if (!group) { return undefined; }
        groups.push(group);
        index = group.end;
    }

    return groups;
}

function getTabularRequiredArgCount(envName: string): number {
    return envName === 'tabular' ? 1 : 2;
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
    const requiredArgs = getTabularRequiredArgCount(envName);

    while (args.length < requiredArgs) {
        const skippedOptional = skipOptionalBracket(text, index);
        if (skippedOptional !== index) {
            index = skippedOptional;
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
        envName,
        beginStart,
        bodyStart: index,
        bodyEnd: endMatch.start,
        end: endMatch.end,
        args,
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

function splitLatexTableCells(rowText: string): string[] {
    const cells: string[] = [];
    let cell = '';
    let depth = 0;

    for (let i = 0; i < rowText.length; i++) {
        const nested = readTabularEnvironmentAt(rowText, i);
        if (nested) {
            cell += rowText.substring(i, nested.end);
            i = nested.end - 1;
            continue;
        }

        const char = rowText[i];
        if (char === '\\') {
            cell += char;
            if (i + 1 < rowText.length) {
                cell += rowText[++i];
            }
            continue;
        }
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth = Math.max(0, depth - 1);
        }

        if (char === '&' && depth === 0) {
            cells.push(cell.trim());
            cell = '';
        } else {
            cell += char;
        }
    }

    cells.push(cell.trim());
    return cells;
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

    for (let i = 0; i < tableContent.length; i++) {
        const nested = readTabularEnvironmentAt(tableContent, i);
        if (nested) {
            current += tableContent.substring(i, nested.end);
            i = nested.end - 1;
            continue;
        }

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
            i = boundary.end - 1;
            continue;
        }

        const char = tableContent[i];
        if (char === '\\') {
            current += char;
            if (i + 1 < tableContent.length) {
                current += tableContent[++i];
            }
            continue;
        }

        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth = Math.max(0, depth - 1);
        }

        current += char;
    }

    if (current.trim()) {
        pushRow();
    }

    return { rows, hasBooktabs, hasRules };
}

function normalizeLatexTableBody(rawContent: string): string {
    return rawContent
        .replace(/\\(?:centering|raggedright|raggedleft|arraybackslash)\b/g, '')
        .replace(/\\(?:small|footnotesize|scriptsize|tiny|normalsize)\b/g, '')
        .replace(/\\cline\{[^}]+\}/g, '\\hline')
        .replace(/\\addlinespace(?:\[.*?\])?/g, '')
        .replace(/\\vspace\*?\{[^}]+\}/g, '')
        .replace(/\\setlength\s*\\[a-zA-Z]+\s*\{[^}]+\}/g, '');
}

function cleanLatexTableCell(text: string): string {
    return text
        .replace(/\\(?:centering|raggedright|raggedleft|arraybackslash)\b/g, '')
        .replace(/\\(?:small|footnotesize|scriptsize|tiny|normalsize)\b/g, '')
        .trim();
}

function stripLatexGroupingBraces(text: string): string {
    return text.replace(/\{([^{}]*)\}/g, '$1');
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

function renderLatexTableInlineContent(content: string, renderer: RenderContext): string {
    const withNestedTables = renderNestedTabulars(cleanLatexTableCell(content), renderer);
    const withMath = withNestedTables.replace(/\$((?:\\.|[^\\$])+?)\$/g, (_match: string, tex: string) => {
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

    const multirowGroups = readCommandGroups(content, 'multirow', 3);
    if (multirowGroups) {
        const parsedRowspan = Number.parseInt(multirowGroups[0].content, 10);
        if (Number.isFinite(parsedRowspan) && Math.abs(parsedRowspan) > 1) {
            rowspan = Math.abs(parsedRowspan);
            attrs.push(`rowspan="${rowspan}"`);
        }
        content = multirowGroups[2].content;
    }

    if (content.startsWith('\\multicolumn')) {
        const multicolumnGroups = readCommandGroups(content, 'multicolumn', 3);
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
        rowspan,
        isEmpty: cleanLatexTableCell(content).length === 0
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
