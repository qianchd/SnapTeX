/**
 * Shared text, URI, and lightweight LaTeX parsing utilities.
 */

import { R_CITATION } from './patterns';
import type { BlockTextSpan, RenderContext, UriLike } from './types';

/**
 * Decodes common LaTeX accents to Unicode for citation and bibliography text.
 */
function decodeLatexAccents(text: string): string {
    const accents: Record<string, string> = {
        '\\"a': 'ä', '\\"o': 'ö', '\\"u': 'ü', '\\"A': 'Ä', '\\"O': 'Ö', '\\"U': 'Ü',
        "\\'a": 'á', "\\'e": 'é', "\\'i": 'í', "\\'o": 'ó', "\\'u": 'ú', "\\'y": 'ý', "\\'c": 'ć',
        "\\'A": 'Á', "\\'E": 'É', "\\'I": 'Í', "\\'O": 'Ó', "\\'U": 'Ú', "\\'Y": 'Ý', "\\'C": 'Ć',
        "\\`a": 'à', "\\`e": 'è', "\\`i": 'ì', "\\`o": 'ò', "\\`u": 'ù',
        "\\`A": 'À', "\\`E": 'È', "\\`I": 'Ì', "\\`O": 'Ò', "\\`U": 'Ù',
        "\\^a": 'â', "\\^e": 'ê', "\\^i": 'î', "\\^o": 'ô', "\\^u": 'û',
        "\\^A": 'Â', "\\^E": 'Ê', "\\^I": 'Î', "\\^O": 'Ô', "\\^U": 'Û',
        "\\~a": 'ã', "\\~n": 'ñ', "\\~o": 'õ',
        "\\~A": 'Ã', "\\~N": 'Ñ', "\\~O": 'Õ',
        "\\v{s}": 'š', "\\v{S}": 'Š', "\\v{z}": 'ž', "\\v{Z}": 'Ž',
        "\\c{c}": 'ç', "\\c{C}": 'Ç',
        "\\ss": 'ß', "\\aa": 'å', "\\AA": 'Å', "\\ae": 'æ', "\\AE": 'Æ', "\\o": 'ø', "\\O": 'Ø'
    };

    text = text.replace(/\\(["'`^~v])\s*\{([a-zA-Z])\}/g, (match, cmd, char) => {
        const key = `\\${cmd}${char}`;
        return accents[key] || match;
    });

    text = text.replace(/\\(["'`^~])([a-zA-Z])/g, (match, cmd, char) => {
        const key = `\\${cmd}${char}`;
        return accents[key] || match;
    });

    text = text.replace(/\\c\s*\{([a-zA-Z])\}/g, (m, c) => accents[`\\c{${c}}`] || m);
    text = text.replace(/\\(ss|aa|AA|ae|AE|o|O)\b/g, (m, c) => accents[`\\${c}`] || m);

    return text;
}

const HTML_ESCAPE_MAP: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};

export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, char => HTML_ESCAPE_MAP[char]);
}

export function escapeHtmlAttribute(text: string): string {
    return escapeHtml(text);
}

export function decodeHtmlAttribute(value: string): string {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

export function escapeScriptRawText(text: string): string {
    return text.replace(/<\/script/gi, '<\\/script');
}

export function sanitizeHttpUrlForAttribute(rawUrl: string): string | undefined {
    const trimmed = rawUrl.trim();
    if (!trimmed) { return undefined; }

    try {
        const url = new URL(trimmed);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return undefined;
        }
        return escapeHtmlAttribute(url.href);
    } catch {
        return undefined;
    }
}

function visibleSyncAnchorSegment(lineText: string, target: number): { start: number; end: number } {
    let best = { start: 0, end: lineText.length };
    let bestDistance = Infinity;
    const consider = (start: number, end: number) => {
        if (end <= start) { return; }
        const distance = target < start ? start - target : target > end ? target - end : 0;
        if (distance < bestDistance) {
            best = { start, end };
            bestDistance = distance;
        }
    };

    const hidden = /\$\$.*?\$\$|\$(?:\\.|[^\\$])*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|%.*/g;
    let segmentStart = 0;
    for (const match of lineText.matchAll(hidden)) {
        const start = match.index ?? 0;
        consider(segmentStart, start);
        segmentStart = start + match[0].length;
        if (match[0].startsWith('%')) { break; }
    }
    consider(segmentStart, lineText.length);
    return best;
}

export function getSyncAnchorContext(lineText: string, char?: number): string {
    const target = Math.max(0, Math.min(lineText.length, char ?? 0));
    const segment = visibleSyncAnchorSegment(lineText, target);
    let start = Math.max(segment.start, target - 20);
    let end = Math.min(segment.end, target + 50);
    const earliestStart = Math.max(segment.start, start - 4);
    while (start > earliestStart && /\S/.test(lineText[start - 1])) { start--; }
    while (end < segment.end && /\S/.test(lineText[end])) { end++; }

    const clean = lineText.substring(start, end)
        .replace(/\\[a-zA-Z]+\*?/g, ' ')
        .replace(/[{}$%]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 40);
    return clean.length >= 5 ? clean : '';
}

export function findNearestSyncAnchorLine(
    anchors: readonly string[],
    startLine: number,
    endLine: number,
    estimatedLine: number,
    getLineText: (line: number) => string
): number | undefined {
    for (const anchor of new Set(anchors)) {
        const normalizedAnchor = anchor.replace(/\s+/g, ' ').trim();
        if (normalizedAnchor.length <= 3) { continue; }

        let closestLine: number | undefined;
        for (let line = startLine; line <= endLine; line++) {
            if (!getLineText(line).replace(/\s+/g, ' ').includes(normalizedAnchor)) { continue; }
            if (closestLine === undefined || Math.abs(line - estimatedLine) < Math.abs(closestLine - estimatedLine)) {
                closestLine = line;
            }
        }
        if (closestLine !== undefined) { return closestLine; }
    }
    return undefined;
}

export function lineAtOffset(text: string, offset: number): number {
    let line = 0;
    const limit = Math.min(Math.max(0, offset), text.length);
    for (let index = 0; index < limit; index++) {
        if (text.charCodeAt(index) === 10) {
            line++;
        }
    }
    return line;
}

export function offsetAtLine(text: string, line: number): number {
    if (line <= 0) { return 0; }
    let currentLine = 0;
    for (let index = 0; index < text.length; index++) {
        if (text.charCodeAt(index) === 10) {
            currentLine++;
            if (currentLine >= line) {
                return index + 1;
            }
        }
    }
    return text.length;
}

export function createHiddenLabelAnchor(labelName: string): string {
    const safeLabel = escapeHtmlAttribute(labelName);
    return `<span id="${safeLabel}" class="latex-label-anchor" data-label="${safeLabel}" style="visibility:hidden; position:relative; top:-50px;"></span>`;
}

const LATEX_LABEL_PATTERN = /\\label\s*\{([^}]+)\}/g;
type StyleHtmlProtector = (html: string, mode?: Parameters<RenderContext['protectHtml']>[2]) => string;
type LatexStyleSpec = [inlineStart: string, inlineEnd: string, blockStyle: string];

const LATEX_STYLE_TAGS: Record<string, LatexStyleSpec> = {
    textbf: ['<strong>', '</strong>', 'font-weight: bold'],
    bf: ['<strong>', '</strong>', 'font-weight: bold'],
    textit: ['<em>', '</em>', 'font-style: italic'],
    emph: ['<em>', '</em>', 'font-style: italic'],
    it: ['<em>', '</em>', 'font-style: italic'],
    texttt: ['<code>', '</code>', 'font-family: monospace'],
    tt: ['<code>', '</code>', 'font-family: monospace'],
    textsf: ['<span style="font-family: sans-serif; font-size: 0.85em;">', '</span>', 'font-family: sans-serif; font-size: 0.85em'],
    sf: ['<span style="font-family: sans-serif; font-size: 0.85em;">', '</span>', 'font-family: sans-serif; font-size: 0.85em'],
    textrm: ['<span style="font-family: serif;">', '</span>', 'font-family: serif'],
    rm: ['<span style="font-family: serif;">', '</span>', 'font-family: serif'],
    underline: ['<u>', '</u>', 'text-decoration: underline']
};
const LATEX_TEXT_STYLE_COMMANDS = ['textbf', 'textit', 'emph', 'texttt', 'textsf', 'textrm', 'underline'];

function startsAfterTextOnLine(source: string, offset: number): boolean {
    const lineStart = Math.max(source.lastIndexOf('\n', offset - 1), source.lastIndexOf('\r', offset - 1)) + 1;
    return source.slice(lineStart, offset).trim().length > 0;
}

function skipLatexInlineWhitespace(text: string, index: number): number {
    while (text[index] === ' ' || text[index] === '\t') {
        index++;
    }
    return index;
}

function renderLatexStyle(style: LatexStyleSpec, content: string, protectHtml: StyleHtmlProtector | undefined, source: string, offset: number): string {
    return applyLatexStyle(style, resolveLatexStyles(content, protectHtml), protectHtml, startsAfterTextOnLine(source, offset));
}

function colorStyleSpec(color: string): LatexStyleSpec {
    return [`<span style="color: ${color}">`, '</span>', `color: ${color}`];
}

function replaceStyleCommandGroups(text: string, protectHtml?: StyleHtmlProtector): string {
    let result = '';
    let cursor = 0;
    let index = 0;

    while (index < text.length) {
        if (text[index] !== '{') {
            index++;
            continue;
        }

        const group = readLatexGroup(text, index, { skipWhitespace: false });
        const replacement = group ? renderStyleCommandGroup(text, group, protectHtml) : undefined;
        if (!group || replacement === undefined) {
            index++;
            continue;
        }

        result += text.slice(cursor, index) + replacement;
        cursor = group.end;
        index = group.end;
    }

    return result + text.slice(cursor);
}

function renderStyleCommandGroup(source: string, group: LatexGroup, protectHtml?: StyleHtmlProtector): string | undefined {
    const innerStart = skipLatexWhitespace(group.content, 0);
    const colorCall = readLatexCommandAt(group.content, innerStart, {
        name: 'color',
        requiredArgs: 1,
        skipWhitespace: false
    });
    if (colorCall) {
        const contentStart = skipLatexInlineWhitespace(group.content, colorCall.end);
        return renderLatexStyle(
            colorStyleSpec(colorCall.requiredArgs[0].content.trim()),
            group.content.slice(contentStart),
            protectHtml,
            source,
            group.start
        );
    }

    for (const cmd of ['bf', 'it', 'sf', 'rm', 'tt']) {
        const call = readLatexCommandAt(group.content, innerStart, {
            name: cmd,
            skipWhitespace: false
        });
        if (!call) { continue; }
        const contentStart = skipLatexInlineWhitespace(group.content, call.end);
        return renderLatexStyle(LATEX_STYLE_TAGS[cmd], group.content.slice(contentStart), protectHtml, source, group.start);
    }

    return undefined;
}

/**
 * Applies text-only LaTeX transforms that do not emit HTML.
 */
export function resolveLatexTextTransforms(text: string): string {
    return text.replace(/\\(?:uppercase|MakeUppercase)\s*\{([^{}]*)\}/g, (_match, content: string) => content.toUpperCase());
}

/**
 * Applies a small subset of LaTeX text styling commands to protected HTML.
 */
export function resolveLatexStyles(text: string, protectHtml?: StyleHtmlProtector): string {
    text = replaceLatexCommandCalls(text, [
        ...LATEX_TEXT_STYLE_COMMANDS
            .map(name => ({
                name,
                requiredArgs: 1,
                render: (call: LatexCommandCall) => renderLatexStyle(
                    LATEX_STYLE_TAGS[name],
                    call.requiredArgs[0].content,
                    protectHtml,
                    text,
                    call.start
                )
            })),
        {
            name: 'textcolor',
            requiredArgs: 2,
            render: call => renderLatexStyle(
                colorStyleSpec(call.requiredArgs[0].content.trim()),
                call.requiredArgs[1].content,
                protectHtml,
                text,
                call.start
            )
        },
        {
            name: 'color',
            requiredArgs: 2,
            render: call => renderLatexStyle(
                colorStyleSpec(call.requiredArgs[0].content.trim()),
                call.requiredArgs[1].content,
                protectHtml,
                text,
                call.start
            )
        }
    ]);

    return replaceStyleCommandGroups(text, protectHtml);
}

/**
 * Extracts \label{...} definitions and replaces them with hidden HTML anchors.
 */
export function extractAndHideLabels(content: string) {
    const labels: string[] = [];
    LATEX_LABEL_PATTERN.lastIndex = 0;
    const cleanContent = content.replace(LATEX_LABEL_PATTERN, (_match, labelName) => {
        labels.push(createHiddenLabelAnchor(labelName));
        return '';
    });
    return { cleanContent, hiddenHtml: labels.join('') };
}

export function extractLatexLabelNames(content: string): string[] {
    const labels: string[] = [];
    LATEX_LABEL_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LATEX_LABEL_PATTERN.exec(content)) !== null) {
        labels.push(match[1]);
    }
    return labels;
}

export function splitLatexCitationKeys(rawKeys: string): string[] {
    return rawKeys.split(',').map(key => key.trim());
}

export function extractLatexCitationKeys(content: string): string[] {
    const keys = new Set<string>();
    R_CITATION.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = R_CITATION.exec(content)) !== null) {
        splitLatexCitationKeys(match[4]).forEach(key => keys.add(key));
    }
    return Array.from(keys);
}

/**
 * Lightweight LaTeX structure readers shared by rule modules.
 */
type LatexGroupDelimiter = 'brace' | 'bracket';
type LatexCommentScanMode = 'ignore' | 'stop' | 'skip-line';

export interface LatexGroup {
    content: string;
    start: number;
    end: number;
    open: '{' | '[';
    close: '}' | ']';
}

interface LatexCommandCall {
    name: string;
    start: number;
    end: number;
    commandEnd: number;
    star: boolean;
    optionalArgs: LatexGroup[];
    requiredArgs: LatexGroup[];
}

interface LatexGroupReadOptions {
    delimiter?: LatexGroupDelimiter;
    skipWhitespace?: boolean;
}

interface LatexCommandReadOptions {
    name: string;
    requiredArgs?: number;
    optionalArgs?: number;
    allowStar?: boolean;
    skipWhitespace?: boolean;
}

interface LatexCommandReplacementRule extends Omit<LatexCommandReadOptions, 'name' | 'skipWhitespace'> {
    name: string | readonly string[];
    render(call: LatexCommandCall): string;
}

interface LatexBraceScanOptions {
    start?: number;
    initialDepth?: number;
    limitChars?: number;
    stopWhenClosed?: boolean;
    commentMode?: LatexCommentScanMode;
}

interface LatexBraceScanResult {
    depth: number;
    closedAt?: number;
}

/**
 * Advances across whitespace and TeX line comments before a token read.
 */
export function skipLatexWhitespace(text: string, index: number): number {
    while (index < text.length) {
        while (index < text.length && /\s/.test(text[index])) { index++; }
        if (text[index] !== '%') { break; }

        const newlineIndex = text.indexOf('\n', index);
        if (newlineIndex === -1) { return text.length; }
        index = newlineIndex + 1;
    }
    return index;
}

type LatexCommentStripMode = 'remove' | 'mask';

/**
 * Handles LaTeX line comments for either display cleanup or source-stable scans.
 *
 * remove: delete comments for preview text.
 * mask: keep line numbers and TeX comment semantics by shortening comments to "%".
 */
export function stripLatexComments(text: string, options: { mode?: LatexCommentStripMode } = {}): string {
    if (options.mode === 'mask') {
        return text.replace(/(?<!\\)%.*$/gm, '%');
    }
    return text
        .replace(/^[ \t]*%.*(?:\r?\n|$)/gm, '')
        .replace(/(?<!\\)%.*(\r?\n)?/g, '');
}

/**
 * Reads one balanced LaTeX group and returns delimiter offsets plus content.
 */
export function readLatexGroup(text: string, startIndex: number, options: LatexGroupReadOptions = {}): LatexGroup | undefined {
    const delimiter = options.delimiter ?? 'brace';
    const open = delimiter === 'bracket' ? '[' : '{';
    const close = delimiter === 'bracket' ? ']' : '}';
    const start = options.skipWhitespace === false ? startIndex : skipLatexWhitespace(text, startIndex);

    if (text[start] !== open) { return undefined; }

    let depth = 1;
    for (let i = start + 1; i < text.length; i++) {
        const char = text[i];
        if (char === '\\') {
            i++;
            continue;
        }
        if (char === open) {
            depth++;
        } else if (char === close) {
            depth--;
            if (depth === 0) {
                return {
                    content: text.substring(start + 1, i),
                    start,
                    end: i + 1,
                    open,
                    close
                };
            }
        }
    }

    return undefined;
}

/**
 * Reads a command exactly at this position after optional leading whitespace.
 */
export function readLatexCommandAt(text: string, startIndex: number, options: LatexCommandReadOptions): LatexCommandCall | undefined {
    const start = options.skipWhitespace === false ? startIndex : skipLatexWhitespace(text, startIndex);
    const command = `\\${options.name}`;
    if (!text.startsWith(command, start)) { return undefined; }

    let commandEnd = start + command.length;
    let star = false;

    if (text[commandEnd] === '*') {
        if (!options.allowStar) { return undefined; }
        star = true;
        commandEnd++;
    }

    if (/[a-zA-Z@]/.test(text[commandEnd] ?? '')) { return undefined; }

    const optionalArgs: LatexGroup[] = [];
    const requiredArgs: LatexGroup[] = [];
    let index = commandEnd;

    const optionalCount = options.optionalArgs ?? 0;
    for (let i = 0; i < optionalCount; i++) {
        const optionalGroup = readLatexGroup(text, index, { delimiter: 'bracket' });
        if (!optionalGroup) { break; }
        optionalArgs.push(optionalGroup);
        index = optionalGroup.end;
    }

    const requiredCount = options.requiredArgs ?? 0;
    for (let i = 0; i < requiredCount; i++) {
        const requiredGroup = readLatexGroup(text, index, { delimiter: 'brace' });
        if (!requiredGroup) { return undefined; }
        requiredArgs.push(requiredGroup);
        index = requiredGroup.end;
    }

    return {
        name: options.name,
        start,
        end: index,
        commandEnd,
        star,
        optionalArgs,
        requiredArgs
    };
}

/**
 * Replaces one or more LaTeX command calls while preserving unmatched source text.
 */
export function replaceLatexCommandCalls(text: string, rules: LatexCommandReplacementRule | LatexCommandReplacementRule[]): string {
    const ruleList = Array.isArray(rules) ? rules : [rules];
    if (ruleList.length === 0) { return text; }

    const ruleByName = new Map<string, LatexCommandReplacementRule>();
    for (const rule of ruleList) {
        for (const name of Array.isArray(rule.name) ? rule.name : [rule.name]) {
            ruleByName.set(name, rule);
        }
    }
    const commandPattern = Array.from(ruleByName.keys())
        .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
    const commandRegex = new RegExp(`\\\\(${commandPattern})\\b`, 'g');
    let result = '';
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = commandRegex.exec(text)) !== null) {
        const commandName = match[1];
        const rule = ruleByName.get(commandName);
        if (!rule) { continue; }

        const commandStart = match.index;
        const call = readLatexCommandAt(text, commandStart, {
            name: commandName,
            requiredArgs: rule.requiredArgs,
            optionalArgs: rule.optionalArgs,
            allowStar: rule.allowStar,
            skipWhitespace: false
        });
        if (!call) {
            continue;
        }

        result += text.slice(cursor, commandStart);
        result += rule.render(call);
        cursor = call.end;
        commandRegex.lastIndex = cursor;
    }

    return result + text.slice(cursor);
}

/**
 * Scans brace depth with the small comment/escape rules used by SnapTeX.
 */
export function scanLatexBraceBalance(text: string, options: LatexBraceScanOptions = {}): LatexBraceScanResult {
    const start = options.start ?? 0;
    const end = Math.min(text.length, start + (options.limitChars ?? text.length));
    const commentMode = options.commentMode ?? 'ignore';
    let depth = options.initialDepth ?? 0;

    for (let i = start; i < end; i++) {
        const char = text[i];

        if (char === '\\') {
            i++;
            continue;
        }

        if (char === '%') {
            if (commentMode === 'stop') {
                break;
            }
            if (commentMode === 'skip-line') {
                const newlineIndex = text.indexOf('\n', i);
                if (newlineIndex === -1) { break; }
                i = newlineIndex;
                continue;
            }
        }

        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (options.stopWhenClosed && depth === 0) {
                return { depth, closedAt: i };
            }
        }
    }

    return { depth };
}

/**
 * Finds a LaTeX command with an optional bracket argument and balanced body.
 */
export function findCommand(text: string, tagName: string) {
    const command = `\\${tagName}`;
    let index = 0;

    while (index < text.length) {
        const commandIndex = text.indexOf(command, index);
        if (commandIndex === -1) { return undefined; }

        const call = readLatexCommandAt(text, commandIndex, {
            name: tagName,
            requiredArgs: 1,
            optionalArgs: 1,
            skipWhitespace: false
        });
        const body = call?.requiredArgs[0];
        if (call && body) {
            return {
                content: body.content.trim(),
                start: call.start,
                end: call.end
            };
        }

        index = commandIndex + command.length;
    }

    return undefined;
}

export function getBlockSpanText(bodyText: string, span: BlockTextSpan): string {
    return `${span.prefix ?? ''}${bodyText.slice(span.start, span.end)}${span.suffix ?? ''}`;
}

function indexToLetters(index: number): string {
    let value = index;
    let result = '';
    while (value > 0) {
        value--;
        result = String.fromCharCode(97 + (value % 26)) + result;
        value = Math.floor(value / 26);
    }
    return result;
}

function replaceCounterToken(template: string, token: '1' | 'i' | 'a', value: string): string | undefined {
    if (token === '1') {
        return template.includes('1') ? template.replace(/1/, value) : undefined;
    }
    const pattern = new RegExp(`(^|[^A-Za-z])${token}([^A-Za-z]|$)`);
    return pattern.test(template)
        ? template.replace(pattern, (_match, before, after) => `${before}${value}${after}`)
        : undefined;
}

export function formatEnumerateLabel(template: string, index: number): string {
    return replaceCounterToken(template, '1', String(index))
        ?? replaceCounterToken(template, 'i', toRoman(index, false))
        ?? replaceCounterToken(template, 'a', indexToLetters(index))
        ?? template;
}

/**
 * Convert numbers to Roman numerals.
 */
export function toRoman(num: number, uppercase: boolean = false): string {
    const lookup: [string, number][] = [
        ['M', 1000], ['CM', 900], ['D', 500], ['CD', 400],
        ['C', 100], ['XC', 90], ['L', 50], ['XL', 40],
        ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1]
    ];
    let roman = '';
    let tempNum = num;
    for (const [letter, value] of lookup) {
        while (tempNum >= value) {
            roman += letter;
            tempNum -= value;
        }
    }
    return uppercase ? roman : roman.toLowerCase();
}

/**
 * Applies HTML styling without hiding Markdown block syntax from Markdown-it.
 */
function applyLatexStyle(style: LatexStyleSpec, content: string, protectHtml: StyleHtmlProtector | undefined, startsAfterText: boolean): string {
    const [startTag, endTag, blockStyle] = style;
    const wrap = (innerText: string) => {
        if (!protectHtml) {
            return `${startTag}${escapeHtml(innerText)}${endTag}`;
        }
        return `${protectHtml(startTag)}${innerText}${protectHtml(endTag)}`;
    };
    if (protectHtml && !startsAfterText && (/^\r?\n/.test(content) || /\r?\n[ \t]*\r?\n/.test(content))) {
        return [
            protectHtml(`<div class="latex-style-scope" style="${blockStyle}">`, 'block'),
            content.trim(),
            protectHtml('</div>', 'block')
        ].join('\n\n');
    }
    if (/\r?\n[ \t]*\r?\n/.test(content)) {
        return content
            .split(/\r?\n[ \t]*\r?\n/)
            .map(part => part.trim())
            .filter(Boolean)
            .map(wrap)
            .join('\n\n');
    }
    return wrap(content);
}

/**
 * Removes common LaTeX markup while preserving readable text for compact
 * previews such as captions, tables, algorithms, and bibliography entries.
 */
export function cleanLatexCommands(text: string, renderer: Pick<RenderContext, 'protectHtml'>): string {
    if (!text) {return '';}

    let processed = decodeLatexAccents(text);

    processed = processed.replace(/\$((?:\\.|[^\\$])*)\$/g, (match) => {
        return renderer.protectHtml('math', match);
    });

    processed = processed
        .replace(/\\textbf\{([^}]+)\}/g, (_match, content) => renderer.protectHtml('bib-style', `<b>${escapeHtml(content)}</b>`))
        .replace(/\\textit\{([^}]+)\}/g, (_match, content) => renderer.protectHtml('bib-style', `<i>${escapeHtml(content)}</i>`))
        .replace(/\\texttt\{([^}]+)\}/g, (_match, content) => renderer.protectHtml('bib-style', `<code>${escapeHtml(content)}</code>`))
        .replace(/\\emph\{([^}]+)\}/g, (_match, content) => renderer.protectHtml('bib-style', `<em>${escapeHtml(content)}</em>`))
        .replace(/\\cite\{[^}]+\}/g, '[cite]')
        .replace(/\\ref\{[^}]+\}/g, '[ref]')
        .replace(/\\([%#&])/g, '$1')
        .replace(/\\small\s*/g, '')
        .replace(/\\large\s*/g, '');

    processed = processed.replace(/\\(?:[a-zA-Z]+)(?:\[.*?\])?(?:\{([^}]*)\})?/g, (match, content) => {
        if (match.includes('XSNAP:')) {
            return match;
        }
        return content || '';
    });

    processed = processed.replace(/([{}])/g, () => '');

    return escapeHtml(processed);
}


export function getBasename(uri: UriLike & { path?: string }): string {
    const pathStr = uri.path ?? uri.toString();
    const idx = pathStr.lastIndexOf('/');
    return idx === -1 ? pathStr : pathStr.substring(idx + 1);
}

export function stableHash(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function normalizeUri(input: string | UriLike): string {
    let str = typeof input === 'string' ? input : input.toString();
    try {
        str = decodeURIComponent(str);
    } catch {
    }

    str = str.replace(/\\/g, '/');

    const isFileUri = str.toLowerCase().startsWith('file://');
    if (isFileUri) {
        str = str.substring(7);
        const isWindowsFilePath = (typeof process !== 'undefined' && process.platform === 'win32') || /^\/?[a-zA-Z]:\//.test(str);
        return isWindowsFilePath ? str.toLowerCase() : str;
    }

    if (/^[a-zA-Z]:\//.test(str)) {
        return str.toLowerCase();
    }

    return str;
}
