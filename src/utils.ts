/**
 * Shared text, URI, and lightweight LaTeX parsing utilities.
 */

import * as vscode from 'vscode';
import type { RenderContext } from './types';

export function capitalizeFirstLetter(string: string): string {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

/**
 * Decodes common LaTeX accents to Unicode for citation and bibliography text.
 */
export function decodeLatexAccents(text: string): string {
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

export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, char => {
        switch (char) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            default: return char;
        }
    });
}

export function escapeHtmlAttribute(text: string): string {
    return escapeHtml(text);
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

export function createHiddenLabelAnchor(labelName: string): string {
    const safeLabel = escapeHtmlAttribute(labelName);
    return `<span id="${safeLabel}" class="latex-label-anchor" data-label="${safeLabel}" style="visibility:hidden; position:relative; top:-50px;"></span>`;
}

/**
 * Applies a small subset of LaTeX text styling commands to protected HTML.
 */
export function resolveLatexStyles(text: string, protectHtml?: (html: string) => string): string {
    text = text.replace(/\\(textbf|textit|emph|texttt|textsf|textrm|underline)\{((?:[^{}]|{[^{}]*})*)\}/g, (match, cmd, content) => {
        let startTag = '', endTag = '';
        switch (cmd) {
            case 'textbf': startTag = '<strong>'; endTag = '</strong>'; break;
            case 'textit':
            case 'emph':
                startTag = '<em>'; endTag = '</em>'; break;
            case 'texttt': startTag = '<code>'; endTag = '</code>'; break;
            case 'textsf': startTag = '<span style="font-family: sans-serif; font-size: 0.85em;">'; endTag = '</span>'; break;
            case 'textrm': startTag = '<span style="font-family: serif;">'; endTag = '</span>'; break;
            case 'underline': startTag = '<u>'; endTag = '</u>'; break;
        }
        return applyStyleToTexList(startTag, endTag, content, protectHtml);
    });

    text = text.replace(/\{\\(bf|it|sf|rm|tt)\s+((?:[^{}]|{[^{}]*})*)\}/g, (match, cmd, content) => {
        let startTag = '', endTag = '';
        switch (cmd) {
            case 'bf': startTag = '<strong>'; endTag = '</strong>'; break;
            case 'it': startTag = '<em>'; endTag = '</em>'; break;
            case 'tt': startTag = '<code>'; endTag = '</code>'; break;
            case 'sf': startTag = '<span style="font-family: sans-serif; font-size: 0.85em;">'; endTag = '</span>'; break;
            case 'rm': startTag = '<span style="font-family: serif;">'; endTag = '</span>'; break;
        }
        return applyStyleToTexList(startTag, endTag, content, protectHtml);
    });

    text = text.replace(/\{\\color\{([a-zA-Z0-9]+)\}\s*((?:[^{}]|{[^{}]*})*)\}/g, (match, color, content) => {
        return applyStyleToTexList(`<span style="color: ${color}">`, '</span>', content, protectHtml);
    });
    text = text.replace(/\\color\{([a-zA-Z]+)\}\{([^}]*)\}/g, (match, color, content) => {
        return applyStyleToTexList(`<span style="color: ${color}">`, '</span>', content, protectHtml);
    });
    text = text.replace(/\\textcolor\{([a-zA-Z0-9]+)\}\{((?:[^{}]|{[^{}]*})*)\}/g, (match, color, content) => {
        return applyStyleToTexList(`<span style="color: ${color}">`, '</span>', content, protectHtml);
    });

    return text;
}

/**
 * Extracts \label{...} definitions and replaces them with hidden HTML anchors.
 */
export function extractAndHideLabels(content: string) {
    const labels: string[] = [];
    const cleanContent = content.replace(/\\label\s*\{([^}]+)\}/g, (match, labelName) => {
        labels.push(createHiddenLabelAnchor(labelName));
        return '';
    });
    return { cleanContent, hiddenHtml: labels.join('') };
}

/**
 * Finds the matching closing brace for a balanced LaTeX-style group.
 */
export function findBalancedClosingBrace(text: string, startIndex: number): number {
    let depth = 0;
    for (let i = startIndex; i < text.length; i++) {
        const char = text[i];

        if (char === '\\') {
            i++;
            continue;
        }

        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

/**
 * Finds a LaTeX command with an optional bracket argument and balanced body.
 */
export function findCommand(text: string, tagName: string) {
    const regex = new RegExp(`\\\\${tagName}(?:\\s*\\[[\\s\\S]*?\\])?\\s*\\{`, 'g');
    const match = regex.exec(text);

    if (match) {
        const startIdx = match.index;
        const contentStart = startIdx + match[0].length;

        const openBraceIdx = startIdx + match[0].length - 1;
        const endIdx = findBalancedClosingBrace(text, openBraceIdx);

        if (endIdx !== -1) {
            return {
                content: text.substring(contentStart, endIdx).trim(),
                start: startIdx,
                end: endIdx
            };
        }
    }
    return undefined;
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
 * Applies HTML tags to content, handling list items specially if present.
 */
function applyStyleToTexList(startTag: string, endTag: string, content: string, protectHtml?: (html: string) => string): string {
    const wrap = (innerText: string) => {
        const html = `${startTag}${escapeHtml(innerText)}${endTag}`;
        return protectHtml ? protectHtml(html) : html;
    };
    const lines = content.split(/\r?\n/);
    if (lines.some(line => /^\s*([-*+]|\d+\.)\s/.test(line))) {
        return lines.map(line => {
            const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
            if (listMatch) {
                const [_, indent, bullet, innerText] = listMatch;
                return `${indent}${bullet} ${wrap(innerText)}`;
            } else {
                return line.trim().length > 0 ? wrap(line) : line;
            }
        }).join('\n');
    }
    return wrap(content);
}

/**
 * Removes common LaTeX markup while preserving readable text for compact
 * previews such as captions, tables, algorithms, and bibliography entries.
 */
export function cleanLatexCommands(text: string, renderer: Pick<RenderContext, 'protect'>): string {
    if (!text) {return '';}

    let processed = decodeLatexAccents(text);

    processed = processed.replace(/\$((?:\\.|[^\\$])*)\$/g, (match) => {
        return renderer.protect('math', match);
    });

    processed = processed
        .replace(/\\textbf\{([^}]+)\}/g, (_match, content) => renderer.protect('bib-style', `<b>${escapeHtml(content)}</b>`))
        .replace(/\\textit\{([^}]+)\}/g, (_match, content) => renderer.protect('bib-style', `<i>${escapeHtml(content)}</i>`))
        .replace(/\\texttt\{([^}]+)\}/g, (_match, content) => renderer.protect('bib-style', `<code>${escapeHtml(content)}</code>`))
        .replace(/\\emph\{([^}]+)\}/g, (_match, content) => renderer.protect('bib-style', `<em>${escapeHtml(content)}</em>`))
        .replace(/\\cite\{[^}]+\}/g, '[cite]')
        .replace(/\\ref\{[^}]+\}/g, '[ref]')
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


export function getBasename(uri: vscode.Uri): string {
    const pathStr = uri.path;
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

export function normalizeUri(input: vscode.Uri | string): string {
    let str = typeof input === 'string' ? input : input.toString();
    try {
        str = decodeURIComponent(str);
    } catch (e) {
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
