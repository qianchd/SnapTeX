import { MetadataResult } from './types';
import { findCommand } from './utils';

export function extractMetadata(text: string): MetadataResult {
    // 1. Pre-cleaning: Remove comment content but KEEP the % marker.
    // Why? If we remove the whole line, we might create double newlines (\n\n) which split blocks incorrectly.
    // We also keep the % to preserve line counts for sync, but remove content to ensure braces don't break matching.
    let cleanedText = text.replace(/(?<!\\)%.*/gm, '%');

    // =======================================================
    // clean $$$$
    cleanedText = cleanedText.replace(/\$\$\s*\$\$/g, ' ');

    let title: string | undefined;
    let author: string | undefined;
    let date: string | undefined;

    // 2. Extract Title and remove it from the body
    const titleRes = findCommand(cleanedText, 'title');
    if (titleRes) {
        title = titleRes.content.replace(/\\\\/g, '<br/>');
        // Physical deletion: Keep content before start and after end
        cleanedText = cleanedText.substring(0, titleRes.start) + cleanedText.substring(titleRes.end + 1);
    }

    // 3. Extract Author and remove it from the body
    const authorRes = findCommand(cleanedText, 'author');
    if (authorRes) {
        author = authorRes.content; // Keep the original extracted content here, leave rendering to rules.ts
        // Physical deletion: Ensure the entire \author{...} block disappears from the body
        cleanedText = cleanedText.substring(0, authorRes.start) + cleanedText.substring(authorRes.end + 1);
    }

    // 4. Extract date and remove it from the body
    const dateRes = findCommand(cleanedText, 'date');
    if (dateRes) {
        date = dateRes.content; // Keep the original extracted content here, leave rendering to rules.ts
        cleanedText = cleanedText.substring(0, dateRes.start) + cleanedText.substring(dateRes.end + 1);
    }


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
    return { data: { macros, title, author, date }, cleanedText };
}