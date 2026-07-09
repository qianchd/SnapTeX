import { readLatexGroup } from './utils';

interface AlgorithmicCommandDescriptor {
    label?: string;
    keyword?: string;
    consumesArgument?: boolean;
    indentBefore?: number;
    indentAfter?: number;
}

const LINE_LABELS = new Map<string, string>([
    ['REQUIRE', 'Require:'],
    ['ENSURE', 'Ensure:'],
    ['INPUT', 'Input:'],
    ['OUTPUT', 'Output:']
]);

const CONTROL_KEYWORDS = new Map<string, string>([
    ['FOR', 'for'],
    ['FORALL', 'for all'],
    ['IF', 'if'],
    ['ELSIF', 'else if'],
    ['WHILE', 'while'],
    ['UNTIL', 'until'],
    ['RETURN', 'return'],
    ['PRINT', 'print'],
    ['ELSE', 'else'],
    ['REPEAT', 'repeat'],
    ['LOOP', 'loop'],
    ['FUNCTION', 'function'],
    ['PROCEDURE', 'procedure'],
    ['ENDFOR', 'end for'],
    ['ENDIF', 'end if'],
    ['ENDWHILE', 'end while'],
    ['ENDREPEAT', 'end repeat'],
    ['ENDLOOP', 'end loop'],
    ['ENDFUNCTION', 'end function'],
    ['ENDPROCEDURE', 'end procedure']
]);

const ARGUMENT_COMMANDS = new Set(['FOR', 'FORALL', 'IF', 'ELSIF', 'WHILE', 'UNTIL', 'RETURN', 'PRINT', 'FUNCTION', 'PROCEDURE']);
const BLOCK_START_COMMANDS = new Set(['FOR', 'FORALL', 'IF', 'WHILE', 'REPEAT', 'LOOP', 'FUNCTION', 'PROCEDURE']);
const BLOCK_MIDDLE_COMMANDS = new Set(['ELSE', 'ELSIF']);
const BLOCK_END_COMMANDS = new Set(['ENDFOR', 'ENDIF', 'ENDWHILE', 'ENDREPEAT', 'ENDLOOP', 'ENDFUNCTION', 'ENDPROCEDURE', 'UNTIL']);
const STRIP_ONLY_COMMANDS = new Set(['STATE', 'STATESTATE']);
const INLINE_MACROS = new Map<string, string>([
    ['TO', 'to'],
    ['AND', 'and'],
    ['OR', 'or'],
    ['NOT', 'not'],
    ['TRUE', 'true'],
    ['FALSE', 'false'],
    ['QUAD', '&emsp;'],
    ['QQUAD', '&emsp;&emsp;']
]);

function normalizeAlgorithmCommand(command: string): string {
    return command.replace(/^\\/, '').toUpperCase();
}

export function describeAlgorithmicCommand(command: string): AlgorithmicCommandDescriptor | undefined {
    const normalized = normalizeAlgorithmCommand(command);
    const label = LINE_LABELS.get(normalized);
    if (label) {
        return { label };
    }
    if (STRIP_ONLY_COMMANDS.has(normalized)) {
        return {};
    }
    const keyword = CONTROL_KEYWORDS.get(normalized);
    if (!keyword) {
        return undefined;
    }

    return {
        keyword,
        consumesArgument: ARGUMENT_COMMANDS.has(normalized),
        indentBefore: BLOCK_END_COMMANDS.has(normalized) || BLOCK_MIDDLE_COMMANDS.has(normalized) ? -1 : 0,
        indentAfter: BLOCK_START_COMMANDS.has(normalized) || BLOCK_MIDDLE_COMMANDS.has(normalized) ? 1 : 0
    };
}

export function algorithmicInlineMacroHtml(command: string): string | undefined {
    return INLINE_MACROS.get(normalizeAlgorithmCommand(command));
}

export function normalizeAlgorithmicInlineMacros(source: string): string {
    return source.replace(/\\([A-Za-z]+)\b/g, (match, command: string) => {
        return algorithmicInlineMacroHtml(command) ?? match;
    });
}

function unwrapSingleGroup(source: string): string {
    const group = readLatexGroup(source, 0);
    return group && source.slice(group.end).trim() === '' ? group.content : source;
}

function consumeLeadingArgument(source: string): { argument: string; rest: string } | undefined {
    const group = readLatexGroup(source, 0);
    return group ? { argument: group.content, rest: source.slice(group.end).trim() } : undefined;
}

export function algorithmicIndentBefore(currentIndent: number, descriptor: AlgorithmicCommandDescriptor | undefined): number {
    return Math.max(0, currentIndent + (descriptor?.indentBefore ?? 0));
}

export function algorithmicIndentAfter(lineIndent: number, descriptor: AlgorithmicCommandDescriptor | undefined): number {
    return Math.max(0, lineIndent + (descriptor?.indentAfter ?? 0));
}

export function algorithmicItemAttributes(indent: number): string {
    const style = indent > 0 ? ` style="padding-left: calc(5px + ${indent * 1.5}em)"` : '';
    return `class="alg-item"${style}`;
}

function renderAlgorithmicLine(line: string, indent: number, renderInline: (source: string) => string): { html: string; nextIndent: number } {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%') || /^\\(?:renewcommand|setlength)\b/.test(trimmed)) {
        return { html: '', nextIndent: indent };
    }

    const match = trimmed.match(/^\\([A-Za-z]+)\b\s*/);
    let content = trimmed;
    let prefix = '';
    let descriptor: AlgorithmicCommandDescriptor | undefined;

    if (match) {
        descriptor = describeAlgorithmicCommand(match[1]);
        if (descriptor) {
            content = trimmed.slice(match[0].length).trim();
            prefix = descriptor.label ? `<strong>${descriptor.label}</strong> ` : '';

            if (descriptor.consumesArgument) {
                const consumed = consumeLeadingArgument(content);
                content = [descriptor.keyword, consumed?.argument ?? content, consumed?.rest ?? '']
                    .filter(Boolean)
                    .join(' ');
            } else if (descriptor.keyword) {
                content = [descriptor.keyword, content].filter(Boolean).join(' ');
            } else {
                content = unwrapSingleGroup(content);
            }
        }
    }

    const lineIndent = algorithmicIndentBefore(indent, descriptor);
    return {
        html: `<li ${algorithmicItemAttributes(lineIndent)}>${prefix}${renderInline(normalizeAlgorithmicInlineMacros(content))}</li>`,
        nextIndent: algorithmicIndentAfter(lineIndent, descriptor)
    };
}

export function renderAlgorithmicList(source: string, showNumbers: boolean, renderInline: (source: string) => string): string {
    let indent = 0;
    const listItems = source.split(/\r?\n/).map(line => {
        const rendered = renderAlgorithmicLine(line, indent, renderInline);
        indent = rendered.nextIndent;
        return rendered.html;
    }).join('');
    const listTag = showNumbers ? 'ol' : 'ul';
    return `<${listTag} class="alg-list">${listItems}</${listTag}>`;
}
