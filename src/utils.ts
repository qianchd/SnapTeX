/**
 * Basic utility function library
 */

export function capitalizeFirstLetter(string: string): string {
    return string.charAt(0).toUpperCase() + string.slice(1);
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
        let depth = 1;
        let i = contentStart;

        for (; i < text.length; i++) {
            const char = text[i];
            if (char === '{' || char === '}') {
                // Check if it is an escaped brace \{ or \}
                let bsCount = 0;
                let j = i - 1;
                while (j >= 0 && text[j] === '\\') { bsCount++; j--; }
                const isEscaped = bsCount % 2 !== 0;

                if (!isEscaped) {
                    if (char === '{') {depth++;}
                    else {depth--;}
                }
            }
            if (depth === 0) {break;}
        }

        if (depth === 0) {
            return {
                content: text.substring(contentStart, i).trim(),
                start: startIdx,
                end: i // Position of closing brace
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

// Future additions: Time formatting, color conversion, complex string cleaning, etc.