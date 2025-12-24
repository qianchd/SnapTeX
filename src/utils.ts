/**
 * Basic utility function library for string manipulation, parsing, and style conversion.
 */

/**
 * Capitalizes the first letter of a string.
 */
export function capitalizeFirstLetter(string: string): string {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

/**
 * [NEW] Decode LaTeX accents to Unicode characters.
 * Handles cases like \"{u} -> ü, \'{e} -> é, \ss -> ß.
 * Crucial for correctly displaying European names in citations.
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

    // 1. Handle standard brace format: \"{u} -> ü
    text = text.replace(/\\(["'`^~v])\s*\{([a-zA-Z])\}/g, (match, cmd, char) => {
        const key = `\\${cmd}${char}`;
        return accents[key] || match;
    });

    // 2. Handle simple non-brace format: \"u -> ü
    text = text.replace(/\\(["'`^~])([a-zA-Z])/g, (match, cmd, char) => {
        const key = `\\${cmd}${char}`;
        return accents[key] || match;
    });

    // 3. Handle special commands: \ss, \aa, \c{c}
    text = text.replace(/\\c\s*\{([a-zA-Z])\}/g, (m, c) => accents[`\\c{${c}}`] || m);
    text = text.replace(/\\(ss|aa|AA|ae|AE|o|O)\b/g, (m, c) => accents[`\\${c}`] || m);

    return text;
}

/**
 * Helper: Apply LaTeX text styles (bold, italic, underline, color, etc.) to HTML tags.
 * This encapsulates logic originally in 'text_styles' rule for reuse.
 */
export function resolveLatexStyles(text: string): string {
    // 1. Standard styles: \textbf{...}, \textit{...}, etc.
    text = text.replace(/\\(textbf|textit|textio|textsf|textrm|underline)\{((?:[^{}]|{[^{}]*})*)\}/g, (match, cmd, content) => {
        let startTag = '', endTag = '';
        switch (cmd) {
            case 'textbf': startTag = '<strong>'; endTag = '</strong>'; break;
            case 'textit': startTag = '<em>'; endTag = '</em>'; break;
            case 'texttt': startTag = '<code>'; endTag = '</code>'; break;
            case 'textsf': startTag = '<span style="font-family: sans-serif;">'; endTag = '</span>'; break;
            case 'textrm': startTag = '<span style="font-family: serif;">'; endTag = '</span>'; break;
            case 'underline': startTag = '<u>'; endTag = '</u>'; break;
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

/**
 * Extracts \label{...} definitions and replaces them with hidden HTML anchors.
 */
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
 * Enhanced LaTeX command search tool.
 * Supports: \command{...}, \command[...]{...}, and multi-line nesting.
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
 * Convert numbers to Roman numerals.
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

/**
 * Applies HTML tags to content, handling list items specially if present.
 */
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
/**
 * Helper: Simple cleanup of LaTeX commands for preview purposes.
 * Keeps text content but removes common formatting commands.
 * This is essential for rendering clean text inside Algorithms, Figures, and Tables.
 */
export function cleanLatexCommands(text: string, renderer: any): string {
    if (!text) {return '';}

    // 0. Decode Accents First (Fixes European names)
    // \"{u} -> ü, \'{a} -> á
    let processed = decodeLatexAccents(text);

    // 1. First, handle inline math inside the text to prevent it from being stripped
    processed = processed.replace(/\$((?:\\.|[^\\$])*)\$/g, (match) => {
        return renderer.pushInlineProtected(match);
    });

    // 2. Clean common formatting but keep content
    processed = processed
        .replace(/\\textbf\{([^}]+)\}/g, '<b>$1</b>')
        .replace(/\\textit\{([^}]+)\}/g, '<i>$1</i>')
        .replace(/\\texttt\{([^}]+)\}/g, '<code>$1</code>')
        .replace(/\\emph\{([^}]+)\}/g, '<em>$1</em>')
        .replace(/\\cite\{[^}]+\}/g, '[cite]')
        .replace(/\\ref\{[^}]+\}/g, '[ref]')
        .replace(/\\small\s*/g, '')
        .replace(/\\large\s*/g, '');

    // 3. Strip remaining generic commands but keep their {content}
    // e.g. \mycommand{Content} -> Content
    processed = processed.replace(/\\(?:[a-zA-Z]+)(?:\[.*?\])?(?:\{([^}]*)\})?/g, (match, content) => {
        // If it looks like a protection placeholder, don't strip it
        if (match.includes('OOSNAPTEX')) {
            return match;
        }
        return content || '';
    });

    // 4. [FIX] Final Cleanup: Remove residual BibTeX protection braces
    // e.g. {Li} -> Li
    // We only remove braces that are NOT part of our protection tokens
    processed = processed.replace(/([{}])/g, (match) => {
        // Simple heuristic: if the brace is part of a token like OOSNAPTEX...OO, we shouldn't have touched it anyway
        // because those are hidden in step 1.
        // So safe to remove all remaining curly braces.
        return '';
    });

    return processed;
}

/**
 * Mix two HEX colors by a weight percentage.
 */
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

/**
 * Add transparency (alpha) to a HEX color.
 */
export function getTransparentColor(color: string, opacity: number): string {
    let c = color.replace('#', '');
    if (c.length === 3) {
        c = c.split('').map(char => char + char).join('');
    }

    const alpha = Math.round(opacity * 255);
    const alphaHex = (alpha + 0x10000).toString(16).substr(-2);
    return `#${c}${alphaHex}`;
}