import { MetadataResult } from './types';

export function extractMetadata(text: string): MetadataResult {
    let cleanedText = text.replace(/(?<!\\)%.*/gm, '');
    let title: string | undefined;
    let author: string | undefined;

    const titleRegex = /\\title\{((?:[^{}]|{[^{}]*})*)\}/g;
    cleanedText = cleanedText.replace(titleRegex, (match, content) => {
        title = content.replace(/\\\\/g, '<br/>').trim();
        return "";
    });

    const authorRegex = /\\author\{((?:[^{}]|{[^{}]*})*)\}/g;
    cleanedText = cleanedText.replace(authorRegex, (match, content) => {
        author = content.replace(/\\\\/g, '<br/>').trim();
        return "";
    });

    const macros: Record<string, string> = {};
    const macroRegex = /\\(newcommand|renewcommand|def|gdef|DeclareMathOperator)(\*?)\s*\{?(\\[a-zA-Z0-9]+)\}?(?:\[(\d+)\])?/g;
    let match;
    while ((match = macroRegex.exec(cleanedText)) !== null) {
        const cmdType = match[1];
        const star = match[2];
        const cmdName = match[3];
        const matchEndIndex = match.index + match[0].length;
        let openBraces = 0, contentStartIndex = -1, contentEndIndex = -1, foundStart = false;

        for (let i = matchEndIndex; i < cleanedText.length; i++) {
            const char = cleanedText[i];
            if (char === '{') {
                if (!foundStart) { contentStartIndex = i + 1; foundStart = true; }
                openBraces++;
            } else if (char === '}') {
                openBraces--;
                if (foundStart && openBraces === 0) { contentEndIndex = i; break; }
            }
        }
        if (contentStartIndex !== -1 && contentEndIndex !== -1) {
            const definition = cleanedText.substring(contentStartIndex, contentEndIndex).trim();
            if (cmdType === 'DeclareMathOperator') {
                macros[cmdName] = star === '*' ? `\\operatorname*{${definition}}` : `\\operatorname{${definition}}`;
            } else {
                macros[cmdName] = definition;
            }
        }
    }

    return { data: { macros, title, author }, cleanedText };
}