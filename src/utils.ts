/**
 * Basic utility function library
 */

export function capitalizeFirstLetter(string: string): string {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

/**
 * Helper: Apply LaTeX text styles (bold, italic, underline, color, etc.)
 * This encapsulates the logic originally in the 'text_styles' rule so it can be reused
 * by block rules (like table/algorithm) that need to render content manually.
 */
export function resolveLatexStyles(text: string): string {
    // 1. Standard styles: \textbf{...}, \textit{...}, etc.
    text = text.replace(/\\(textbf|textit|texttt|textsf|textrm|underline)\{((?:[^{}]|{[^{}]*})*)\}/g, (match, cmd, content) => {
        let startTag = '', endTag = '';
        switch (cmd) {
            case 'textbf': startTag = '<strong>'; endTag = '</strong>'; break;
            case 'textit': startTag = '<em>'; endTag = '</em>'; break;
            case 'texttt': startTag = '<code>'; endTag = '</code>'; break;
            case 'textsf': startTag = '<span style="font-family: sans-serif;">'; endTag = '</span>'; break;
            case 'textrm': startTag = '<span style="font-family: serif;">'; endTag = '</span>'; break;
            case 'underline': startTag = '<u>'; endTag = '</u>'; break; // [NEW] Added support for \underline
        }
        return applyStyleToTexList(startTag, endTag, content);
    });

    // 2. Old LaTeX styles: {\bf ...}, {\it ...}, etc.
    text = text.replace(/\{\\(bf|it|sf|rm|tt)\s+((?:[^{}]|{[^{}]*})*)\}/g, (match, cmd, content) => {
        let startTag = '', endTag = '';
        switch (cmd) {
            case 'bf': startTag = '<strong>'; endTag = '</strong>'; break;
            case 'it': startTag = '<em>'; endTag = '</em>'; break;
            case 'tt': startTag = '<code>'; endTag = '</code>'; break;
            case 'sf': startTag = '<span style="font-family: sans-serif;">'; endTag = '</span>'; break;
            case 'rm': startTag = '<span style="font-family: serif;">'; endTag = '</span>'; break;
        }
        return applyStyleToTexList(startTag, endTag, content);
    });

    // 3. Color: {\color{red} ...} or \color{red}{...}
    // Handle {\color{name} content}
    text = text.replace(/\{\\color\{([a-zA-Z0-9]+)\}\s*((?:[^{}]|{[^{}]*})*)\}/g, (match, color, content) => {
        return applyStyleToTexList(`<span style="color: ${color}">`, '</span>', content);
    });
    // Handle \color{name}{content}
    text = text.replace(/\\color\{([a-zA-Z]+)\}\{([^}]*)\}/g, (match, color, content) => {
        return applyStyleToTexList(`<span style="color: ${color}">`, '</span>', content);
    });

    return text;
}

export function extractAndHideLabels(content: string) {
        const labels: string[] = [];
        const cleanContent = content.replace(/\\label\{([^}]+)\}/g, (match, labelName) => {
            const safeLabel = labelName.replace(/"/g, '&quot;');
            labels.push(`<span id="${safeLabel}" class="latex-label-anchor" data-label="${safeLabel}" style="display:none"></span>`);
            return '';
        });
        return { cleanContent, hiddenHtml: labels.join('') };
    }

/**
 * [New Helper] Find the index of the matching closing brace for the brace at startIndex.
 * Handles nested braces and escaped braces (\{, \}) correctly.
 */
export function findBalancedClosingBrace(text: string, startIndex: number): number {
    let depth = 0;
    for (let i = startIndex; i < text.length; i++) {
        const char = text[i];

        // Skip escaped characters
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
 * Enhanced LaTeX command search tool
 * Supports: \command{...}, \command[...]{...}, and multi-line nesting
 */
export function findCommand(text: string, tagName: string) {
    // Improved regex: Supports optional parameters [\s\S]*? and spaces between command and left brace
    const regex = new RegExp(`\\\\${tagName}(?:\\s*\\[[\\s\\S]*?\\])?\\s*\\{`, 'g');
    const match = regex.exec(text);

    if (match) {
        const startIdx = match.index;
        const contentStart = startIdx + match[0].length;

        // Use the new helper to find the closing brace
        // match[0] ends with '{', so the opening brace is at match.index + match[0].length - 1
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
 * Convert numbers to Roman numerals
 * @param num Arabic number to convert
 * @param uppercase Whether to return uppercase
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

export function applyStyleToTexList(startTag: string, endTag: string, content: string): string {
    const lines = content.split(/\r?\n/);
    if (lines.some(line => /^\s*([-*+]|\d+\.)\s/.test(line))) {
        return lines.map(line => {
            const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
            if (listMatch) {
                const [_, indent, bullet, innerText] = listMatch;
                return `${indent}${bullet} ${startTag}${innerText}${endTag}`;
            } else {
                return line.trim().length > 0 ? `${startTag}${line}${endTag}` : line;
            }
        }).join('\n');
    }
    return `${startTag}${content}${endTag}`;
}

/**
 * Helper: Simple cleanup of LaTeX commands for preview purposes.
 * Keeps text content but removes common formatting commands.
 * This is essential for rendering clean text inside Algorithms, Figures, and Tables.
 */
export function cleanLatexCommands(text: string, renderer: any): string {
    // 1. First, handle inline math inside the text to prevent it from being stripped
    let processed = text.replace(/\$((?:\\.|[^\\$])*)\$/g, (match) => {
        return renderer.pushInlineProtected(match);
    });

    // 2. Clean common formatting but keep content
    processed = processed
        .replace(/\\textbf\{([^}]+)\}/g, '<b>$1</b>')
        .replace(/\\textit\{([^}]+)\}/g, '<i>$1</i>')
        .replace(/\\texttt\{([^}]+)\}/g, '<code>$1</code>')
        .replace(/\\cite\{[^}]+\}/g, '[cite]')
        .replace(/\\ref\{[^}]+\}/g, '[ref]')
        .replace(/\\small\s*/g, '');

    // 3. Strip remaining generic commands but keep their {content}
    processed = processed.replace(/\\(?:[a-zA-Z]+)(?:\[.*?\])?(?:\{([^}]*)\})?/g, (match, content) => {
        // If it looks like a protection placeholder, don't strip it
        if (match.includes('OOPROTECTED_BLOCK_')) {
            return match;
        }
        return content || '';
    });

    return processed;
}

export function mixColors(color1: string, color2: string, weight: number): string {
    const p = weight / 100;
    const parse = (c: string) => c.replace('#', '').match(/.{2}/g)!.map(x => parseInt(x, 16));

    const [r1, g1, b1] = parse(color1);
    const [r2, g2, b2] = parse(color2);

    const r = Math.round(r1 + (r2 - r1) * p);
    const g = Math.round(g1 + (g2 - g1) * p);
    const b = Math.round(b1 + (b2 - b1) * p);

    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export function getTransparentColor(color: string, opacity: number): string {
    let c = color.replace('#', '');
    if (c.length === 3) {
        c = c.split('').map(char => char + char).join('');
    }

    const alpha = Math.round(opacity * 255);
    const alphaHex = (alpha + 0x10000).toString(16).substr(-2);
    return `#${c}${alphaHex}`;
}

// Future additions: Time formatting, color conversion, complex string cleaning, etc.