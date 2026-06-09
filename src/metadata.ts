import { MetadataResult } from './types';
import { findCommand, readLatexGroup, skipLatexWhitespace } from './utils';

type MacroDefinitionCommand = 'newcommand' | 'renewcommand' | 'providenewcommand' | 'def' | 'gdef' | 'DeclareMathOperator';

interface MacroDefinitionHeader {
    command: MacroDefinitionCommand;
    name: string;
    star: boolean;
    argCount: number;
    hasDefaultArgument: boolean;
    body: {
        content: string;
        start: number;
    };
}

function readMacroName(text: string, index: number): { name: string; end: number } | undefined {
    index = skipLatexWhitespace(text, index);

    const grouped = readLatexGroup(text, index, { delimiter: 'brace', skipWhitespace: false });
    if (grouped) {
        const name = grouped.content.trim();
        return /^\\[a-zA-Z0-9@]+$/.test(name) ? { name, end: grouped.end } : undefined;
    }

    if (text[index] !== '\\') { return undefined; }
    let end = index + 1;
    while (end < text.length && /[a-zA-Z0-9@]/.test(text[end])) { end++; }
    const name = text.substring(index, end);
    return /^\\[a-zA-Z0-9@]+$/.test(name) ? { name, end } : undefined;
}

function readMacroDefinitionHeader(fullDef: string): MacroDefinitionHeader | undefined {
    const commandMatch = /^\\((?:provide|re)?newcommand|g?def|DeclareMathOperator)(\*)?/.exec(fullDef);
    if (!commandMatch) { return undefined; }

    const command = commandMatch[1] as MacroDefinitionCommand;
    const star = commandMatch[2] === '*';
    const macroName = readMacroName(fullDef, commandMatch[0].length);
    if (!macroName) { return undefined; }

    let index = macroName.end;
    let argCount = 0;
    let hasDefaultArgument = false;

    if (command === 'newcommand' || command === 'renewcommand' || command === 'providenewcommand') {
        const argCountGroup = readLatexGroup(fullDef, index, { delimiter: 'bracket' });
        if (argCountGroup && /^\d+$/.test(argCountGroup.content.trim())) {
            argCount = parseInt(argCountGroup.content.trim(), 10);
            index = argCountGroup.end;

            const defaultArgGroup = readLatexGroup(fullDef, index, { delimiter: 'bracket' });
            if (defaultArgGroup) {
                hasDefaultArgument = true;
                index = defaultArgGroup.end;
            }
        }
    } else if (command === 'def' || command === 'gdef') {
        const bodyIndex = fullDef.indexOf('{', index);
        if (bodyIndex === -1) { return undefined; }
        index = bodyIndex;
    }

    const body = readLatexGroup(fullDef, index, { delimiter: 'brace' });
    if (!body) { return undefined; }

    return {
        command,
        name: macroName.name,
        star,
        argCount,
        hasDefaultArgument,
        body: {
            content: body.content,
            start: body.start
        }
    };
}

/**
 * Converts simple \newcommand definitions to \def syntax accepted by TikZJax.
 */
function transpileToDef(header: MacroDefinitionHeader, fullDef: string): string {
    if (!header.command.endsWith('newcommand') || header.hasDefaultArgument) {return fullDef;}

    let args = "";
    for(let i=1; i<=header.argCount; i++) {args += `#${i}`;}

    return `\\def${header.name}${args}${fullDef.substring(header.body.start)}`;
}

interface TextRange {
    start: number;
    end: number;
}

interface DefinitionRecord extends TextRange {
    fullDef: string;
}

function consumeControlSequence(text: string, index: number): number {
    if (text[index] !== '\\') { return index; }
    let i = index + 1;
    while (i < text.length && /[a-zA-Z@]/.test(text[i])) { i++; }
    return i > index + 1 ? i : index + 2;
}

function findDefinitionEnd(text: string, tokenEndIndex: number): number {
    let i = tokenEndIndex;
    let consumedGroup = false;

    while (i < text.length) {
        const beforeWhitespace = i;
        i = skipLatexWhitespace(text, i);
        const char = text[i];

        if (char === '[') {
            const group = readLatexGroup(text, i, { delimiter: 'bracket', skipWhitespace: false });
            if (!group) { return -1; }
            i = group.end;
            continue;
        }

        if (char === '{') {
            const group = readLatexGroup(text, i, { delimiter: 'brace', skipWhitespace: false });
            if (!group) { return -1; }
            consumedGroup = true;
            i = group.end;
            continue;
        }

        if (!consumedGroup && char === '\\') {
            i = consumeControlSequence(text, i);
            continue;
        }

        if (!consumedGroup) {
            i++;
            continue;
        }

        return beforeWhitespace;
    }

    return consumedGroup ? i : -1;
}

function blankOutRanges(text: string, ranges: TextRange[]): string {
    if (ranges.length === 0) { return text; }

    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    let result = "";
    let cursor = 0;

    for (const range of sorted) {
        const start = Math.max(cursor, range.start);
        const end = Math.max(start, range.end);
        result += text.substring(cursor, start);
        result += text.substring(start, end).replace(/[^\r\n]/g, '');
        cursor = end;
    }

    result += text.substring(cursor);
    return result;
}

function collectDefinitions(text: string): DefinitionRecord[] {
    const records: DefinitionRecord[] = [];
    const defRegex = /\\(provide|re)?(newcommand|def|gdef|DeclareMathOperator|usetikzlibrary|tikzset|definecolor)(\*?)/g;

    let defMatch;
    while ((defMatch = defRegex.exec(text)) !== null) {
        const start = defMatch.index;
        const end = findDefinitionEnd(text, start + defMatch[0].length);
        if (end === -1) { continue; }

        records.push({ start, end, fullDef: text.substring(start, end) });
        defRegex.lastIndex = end;
    }

    return records;
}

function extractKatexMacro(header: MacroDefinitionHeader): { name: string; definition: string } | undefined {
    if (header.command === 'providenewcommand') { return undefined; }

    const rawDefinition = header.body.content.trim();
    const definition = header.command === 'DeclareMathOperator'
        ? (header.star ? `\\operatorname*{${rawDefinition}}` : `\\operatorname{${rawDefinition}}`)
        : rawDefinition;

    return { name: header.name, definition };
}

/**
 * Extracts preamble metadata, macro definitions, and TikZ globals.
 *
 * The returned cleanedText preserves line structure for source mapping while
 * blanking definitions that should not render as document body content.
 */
export function extractMetadata(text: string): MetadataResult {
    let cleanedText = text.replace(/(?<!\\)%.*/gm, '%');

    cleanedText = cleanedText.replace(/\$\$\s*\$\$/g, ' ');

    const todayStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    cleanedText = cleanedText.replace(/\\today\b/g, todayStr);

    let title: string | undefined;
    let author: string | undefined;
    let date: string | undefined;

    const titleRes = findCommand(cleanedText, 'title');
    if (titleRes) {
        title = titleRes.content.replace(/\\\\/g, '<br/>');
        cleanedText = cleanedText.substring(0, titleRes.start) + cleanedText.substring(titleRes.end);
    }

    const authorRes = findCommand(cleanedText, 'author');
    if (authorRes) {
        author = authorRes.content;
        cleanedText = cleanedText.substring(0, authorRes.start) + cleanedText.substring(authorRes.end);
    }

    const dateRes = findCommand(cleanedText, 'date');
    if (dateRes) {
        date = dateRes.content;
        cleanedText = cleanedText.substring(0, dateRes.start) + cleanedText.substring(dateRes.end);
    }

    const tikzGlobalParts: string[] = [];
    const tikzMacroMap = new Map<string, string>();
    const macros: Record<string, string> = {};

    const definitionRecords = collectDefinitions(cleanedText);
    for (const record of definitionRecords) {
        const { fullDef } = record;

        if (/\\(usetikzlibrary|tikzset|definecolor)/.test(fullDef)) {
            if (!tikzGlobalParts.includes(fullDef)) {
                tikzGlobalParts.push(fullDef);
            }
            continue;
        }

        const header = readMacroDefinitionHeader(fullDef);
        if (!header) { continue; }

        const finalDef = transpileToDef(header, fullDef);
        const tikzName = header.command === 'DeclareMathOperator' ? null : header.name;
        if (tikzName && !tikzMacroMap.has(tikzName)) {
            tikzMacroMap.set(tikzName, finalDef);
        }

        const katexMacro = extractKatexMacro(header);
        if (katexMacro) {
            macros[katexMacro.name] = katexMacro.definition;
        }
    }

    const tikzGlobal = tikzGlobalParts.join('\n');
    cleanedText = blankOutRanges(cleanedText, definitionRecords);
    return { data: { macros, tikzGlobal, tikzMacroMap, title, author, date }, cleanedText };
}
