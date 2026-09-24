import type { LatexMacroDefinition } from './types';
import { expandLatexTextMacros, readLatexCommandAt, readLatexGroup, replaceLatexCommandCalls, skipLatexWhitespace } from './utils';

interface AlgorithmicCommandDescriptor {
    label?: string;
    labelSource?: string;
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
const STRIP_ONLY_COMMANDS = new Set(['STATE', 'STATEX']);
const INLINE_MACROS = new Map<string, string>([
    ['RETURN', 'return'],
    ['TO', 'to'],
    ['AND', 'and'],
    ['OR', 'or'],
    ['NOT', 'not'],
    ['TRUE', 'true'],
    ['FALSE', 'false'],
    ['QUAD', '&emsp;'],
    ['QQUAD', '&emsp;&emsp;']
]);

const ALGORITHM2E_LINE_COMMANDS = new Map<string, string>([
    ['KwIn', 'REQUIRE'], ['KwInput', 'REQUIRE'], ['KwData', 'REQUIRE'],
    ['KwOut', 'ENSURE'], ['KwOutput', 'ENSURE'], ['KwResult', 'ENSURE'],
    ['Return', 'RETURN'], ['KwRet', 'RETURN']
]);
const ALGORITHM2E_BLOCK_COMMANDS = new Map<string, [string, string]>([
    ['For', ['FOR', 'ENDFOR']], ['ForEach', ['FOR', 'ENDFOR']],
    ['While', ['WHILE', 'ENDWHILE']],
    ['If', ['IF', 'ENDIF']], ['uIf', ['IF', 'ENDIF']], ['lIf', ['IF', 'ENDIF']],
    ['Fn', ['FUNCTION', 'ENDFUNCTION']]
]);
const ALGORITHM2E_SETUP_COMMANDS = new Map<string, number>([
    ['SetKwInOut', 2], ['SetKwInput', 2], ['SetKwProg', 4], ['SetKwFunction', 2],
    ['DontPrintSemicolon', 0], ['SetAlgoLined', 0], ['SetAlgoNoLine', 0], ['LinesNumbered', 0]
]);

function normalizeAlgorithmCommand(command: string): string {
    return command.replace(/^\\/, '').toUpperCase();
}

function mathSegmentEnd(source: string, index: number): number | undefined {
    const delimiter = source.startsWith('$$', index) ? '$$'
        : source[index] === '$' ? '$'
            : source.startsWith('\\(', index) ? '\\)'
                : source.startsWith('\\[', index) ? '\\]'
                    : undefined;
    if (!delimiter) { return undefined; }

    let end = source.indexOf(delimiter, index + delimiter.length);
    while (end >= 0 && delimiter.includes('$') && source[end - 1] === '\\') {
        end = source.indexOf(delimiter, end + delimiter.length);
    }
    return end < 0 ? undefined : end + delimiter.length;
}

export function describeAlgorithmicCommand(
    command: string,
    macros: Readonly<Record<string, LatexMacroDefinition>> = {}
): AlgorithmicCommandDescriptor | undefined {
    const normalized = normalizeAlgorithmCommand(command);
    const label = LINE_LABELS.get(normalized);
    if (label) {
        return { label };
    }
    const definition = macros[`\\${command}`];
    if (definition?.argumentCount === 0) {
        const expanded = expandLatexTextMacros(definition.body, macros);
        const item = readLatexCommandAt(expanded, 0, { name: 'item', optionalArgs: 1, requiredArgs: 0, skipWhitespace: false });
        if (item && expanded.slice(item.end).trim() === '' && item.optionalArgs[0]) {
            return { labelSource: item.optionalArgs[0].content };
        }
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

function normalizeAlgorithmicInlineMacros(source: string): string {
    source = replaceLatexCommandCalls(source, {
        name: ['Comment', 'COMMENT'],
        requiredArgs: 1,
        render: call => `\\textit{(${call.requiredArgs[0].content})}`
    });
    const replace = (text: string) => text.replace(/\\([A-Za-z]+)\b/g, (match, command: string) => {
        if (command === 'KwTo') { return 'to'; }
        return algorithmicInlineMacroHtml(command) ?? match;
    });
    let output = '';
    let textStart = 0;
    for (let index = 0; index < source.length;) {
        const mathEnd = mathSegmentEnd(source, index);
        if (!mathEnd) {
            index++;
            continue;
        }
        output += replace(source.slice(textStart, index)) + source.slice(index, mathEnd);
        index = mathEnd;
        textStart = index;
    }
    return output + replace(source.slice(textStart));
}

function readAlgorithm2eCommand(source: string, index: number, requiredArgs: number) {
    const name = /^\\([A-Za-z@]+|.)/.exec(source.slice(index))?.[1];
    return name ? readLatexCommandAt(source, index, { name, requiredArgs, skipWhitespace: false }) : undefined;
}

function normalizeAlgorithm2eSource(source: string, customLineLabels = new Map<string, string>()): string {
    let output = '';
    for (let index = 0; index < source.length;) {
        const mathEnd = mathSegmentEnd(source, index);
        if (mathEnd) {
            output += source.slice(index, mathEnd);
            index = mathEnd;
            continue;
        }
        if (source[index] !== '\\') {
            output += /[\r\n]/.test(source[index]) ? ' ' : source[index];
            index++;
            continue;
        }

        const name = /^\\([A-Za-z@]+|.)/.exec(source.slice(index))?.[1];
        if (!name) {
            output += source[index++];
            continue;
        }
        if (name === ';' || name === '\\') {
            output += '\n';
            index += 2;
            continue;
        }

        const setupArgs = ALGORITHM2E_SETUP_COMMANDS.get(name);
        if (setupArgs !== undefined) {
            const call = readAlgorithm2eCommand(source, index, setupArgs);
            if (call && (name === 'SetKwInOut' || name === 'SetKwInput')) {
                customLineLabels.set(call.requiredArgs[0].content.trim(), call.requiredArgs[1].content.trim());
            }
            index = call?.end ?? index + name.length + 1;
            continue;
        }

        const customLabel = customLineLabels.get(name);
        if (customLabel) {
            const call = readAlgorithm2eCommand(source, index, 1);
            if (call) {
                output += `\n\\STATE{\\textbf{${customLabel}:} ${call.requiredArgs[0].content}}\n`;
                index = call.end;
                continue;
            }
        }

        const lineCommand = ALGORITHM2E_LINE_COMMANDS.get(name);
        if (lineCommand) {
            const call = readAlgorithm2eCommand(source, index, 1);
            if (call) {
                output += `\n\\${lineCommand}{${call.requiredArgs[0].content}}\n`;
                index = call.end;
            } else {
                output += `\\${lineCommand} `;
                index += name.length + 1;
            }
            continue;
        }

        if (name === 'eIf') {
            const call = readAlgorithm2eCommand(source, index, 3);
            if (call) {
                const [condition, yes, no] = call.requiredArgs.map(argument => argument.content);
                output += `\n\\IF{${condition}}\n${normalizeAlgorithm2eSource(yes, customLineLabels)}\n\\ELSE\n${normalizeAlgorithm2eSource(no, customLineLabels)}\n\\ENDIF\n`;
                index = call.end;
                continue;
            }
        }

        const blockCommand = ALGORITHM2E_BLOCK_COMMANDS.get(name);
        if (blockCommand) {
            const call = readAlgorithm2eCommand(source, index, 2);
            if (call) {
                const [start, end] = blockCommand;
                output += `\n\\${start}{${call.requiredArgs[0].content}}\n${normalizeAlgorithm2eSource(call.requiredArgs[1].content, customLineLabels)}\n`;
                let nextIndex = skipLatexWhitespace(source, call.end);
                const elseCall = start === 'IF' ? readLatexCommandAt(source, nextIndex, { name: 'Else', requiredArgs: 1, skipWhitespace: false }) : undefined;
                if (elseCall) {
                    output += `\\ELSE\n${normalizeAlgorithm2eSource(elseCall.requiredArgs[0].content, customLineLabels)}\n`;
                    nextIndex = elseCall.end;
                }
                output += `\\${end}\n`;
                index = nextIndex;
                continue;
            }
        }

        output += source.slice(index, index + name.length + 1);
        index += name.length + 1;
    }
    return output;
}

export function isAlgorithm2eSource(source: string): boolean {
    return /\\(?:Kw(?:In|Input|Data|Out|Output|Result|Ret|To)|(?:For|ForEach|While|If|uIf|lIf|eIf|Return)\b|DontPrintSemicolon|SetKw)/.test(source);
}

export function renderAlgorithm2eList(source: string, renderInline: (source: string) => string): string {
    return renderAlgorithmicList(normalizeAlgorithm2eSource(source), false, renderInline);
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

function renderAlgorithmicLine(
    line: string,
    indent: number,
    renderInline: (source: string) => string,
    macros: Readonly<Record<string, LatexMacroDefinition>>
): { html: string; nextIndent: number } {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%') || /^\\(?:renewcommand|setlength)\b/.test(trimmed)) {
        return { html: '', nextIndent: indent };
    }

    const match = trimmed.match(/^\\([A-Za-z]+)\b\s*/);
    let content = trimmed;
    let prefix = '';
    let descriptor: AlgorithmicCommandDescriptor | undefined;
    const item = readLatexCommandAt(trimmed, 0, { name: 'item', optionalArgs: 1, requiredArgs: 0, skipWhitespace: false });

    if (item) {
        content = trimmed.slice(item.end).trim();
        prefix = item.optionalArgs[0] ? `${renderInline(item.optionalArgs[0].content)} ` : '';
        descriptor = {};
    } else if (match) {
        descriptor = describeAlgorithmicCommand(match[1], macros);
        if (descriptor) {
            content = trimmed.slice(match[0].length).trim();
            prefix = descriptor.label ? `<strong>${descriptor.label}</strong> `
                : descriptor.labelSource ? `${renderInline(descriptor.labelSource)} ` : '';

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

export function renderAlgorithmicList(
    source: string,
    showNumbers: boolean,
    renderInline: (source: string) => string,
    macros: Readonly<Record<string, LatexMacroDefinition>> = {}
): string {
    let indent = 0;
    const listItems = source.split(/\r?\n/).map(line => {
        const rendered = renderAlgorithmicLine(line, indent, renderInline, macros);
        indent = rendered.nextIndent;
        return rendered.html;
    }).join('');
    const listTag = showNumbers ? 'ol' : 'ul';
    return `<${listTag} class="alg-list">${listItems}</${listTag}>`;
}
