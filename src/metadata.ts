import { MetadataResult } from './types';
import { findBalancedClosingBrace, findCommand } from './utils';

/**
 * Converts simple \newcommand definitions to \def syntax accepted by TikZJax.
 */
function transpileToDef(fullDef: string): string {
    const match = /^\\(?:re|provide)?newcommand\*?\s*(?:\{(\\[a-zA-Z0-9@]+)\}|(\\[a-zA-Z0-9@]+))(?:\s*\[(\d+)\])?/.exec(fullDef);
    if (!match) {return fullDef;}

    const name = match[1] || match[2];
    const argCount = match[3] ? parseInt(match[3], 10) : 0;

    const headerLength = match[0].length;
    const remainder = fullDef.substring(headerLength);
    const bodyStart = remainder.indexOf('{');
    if (bodyStart === -1) {return fullDef;}

    const preBody = remainder.substring(0, bodyStart).trim();
    if (preBody.startsWith('[')) {return fullDef;}

    const body = remainder.substring(bodyStart);
    let args = "";
    for(let i=1; i<=argCount; i++) {args += `#${i}`;}

    return `\\def${name}${args}${body}`;
}

/**
 * Extracts the command name from a macro definition string.
 */
function extractMacroName(def: string): string | null {
    const match = /\\(?:def\s*(\\[a-zA-Z0-9@]+)|(?:re|provide)?newcommand\*?\s*(?:\{(\\[a-zA-Z0-9@]+)\}|(\\[a-zA-Z0-9@]+)))/.exec(def);
    if (match) {
        return match[1] || match[2] || match[3];
    }
    return null;
}

interface TextRange {
    start: number;
    end: number;
}

interface DefinitionRecord extends TextRange {
    fullDef: string;
}

function skipWhitespace(text: string, index: number): number {
    let i = index;
    while (i < text.length && /\s/.test(text[i])) { i++; }
    return i;
}

function findClosingBracket(text: string, startIndex: number): number {
    let depth = 0;
    for (let i = startIndex; i < text.length; i++) {
        const char = text[i];
        if (char === '\\') {
            i++;
            continue;
        }
        if (char === '[') {
            depth++;
        } else if (char === ']') {
            depth--;
            if (depth === 0) { return i; }
        }
    }
    return -1;
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
        i = skipWhitespace(text, i);
        const char = text[i];

        if (char === '[') {
            const close = findClosingBracket(text, i);
            if (close === -1) { return -1; }
            i = close + 1;
            continue;
        }

        if (char === '{') {
            const close = findBalancedClosingBrace(text, i);
            if (close === -1) { return -1; }
            consumedGroup = true;
            i = close + 1;
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

function extractKatexMacro(fullDef: string): { name: string; definition: string } | undefined {
    const match = /\\(newcommand|renewcommand|def|gdef|DeclareMathOperator)(\*?)\s*\{?(\\[a-zA-Z0-9]+)\}?(?:\[(\d+)\])?/.exec(fullDef);
    if (!match) { return undefined; }

    const cmdType = match[1];
    const star = match[2];
    const name = match[3];
    const bodyStart = fullDef.indexOf('{', match.index + match[0].length);
    if (bodyStart === -1) { return undefined; }

    const bodyEnd = findBalancedClosingBrace(fullDef, bodyStart);
    if (bodyEnd === -1) { return undefined; }

    const rawDefinition = fullDef.substring(bodyStart + 1, bodyEnd).trim();
    const definition = cmdType === 'DeclareMathOperator'
        ? (star === '*' ? `\\operatorname*{${rawDefinition}}` : `\\operatorname{${rawDefinition}}`)
        : rawDefinition;

    return { name, definition };
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
        cleanedText = cleanedText.substring(0, titleRes.start) + cleanedText.substring(titleRes.end + 1);
    }

    const authorRes = findCommand(cleanedText, 'author');
    if (authorRes) {
        author = authorRes.content;
        cleanedText = cleanedText.substring(0, authorRes.start) + cleanedText.substring(authorRes.end + 1);
    }

    const dateRes = findCommand(cleanedText, 'date');
    if (dateRes) {
        date = dateRes.content;
        cleanedText = cleanedText.substring(0, dateRes.start) + cleanedText.substring(dateRes.end + 1);
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

        let finalDef = fullDef;
        if (/\\(provide|re)?newcommand/.test(fullDef)) {
            finalDef = transpileToDef(fullDef);
        }

        const tikzName = extractMacroName(finalDef);
        if (tikzName && !tikzMacroMap.has(tikzName)) {
            tikzMacroMap.set(tikzName, finalDef);
        }

        const katexMacro = extractKatexMacro(fullDef);
        if (katexMacro) {
            macros[katexMacro.name] = katexMacro.definition;
        }
    }

    const tikzGlobal = tikzGlobalParts.join('\n');
    cleanedText = blankOutRanges(cleanedText, definitionRecords);
    return { data: { macros, tikzGlobal, tikzMacroMap, title, author, date }, cleanedText };
}
