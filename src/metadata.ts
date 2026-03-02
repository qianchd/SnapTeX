import { MetadataResult } from './types';
import { findCommand } from './utils';

/**
 * Helper to transpile \newcommand to \def for TikZJax.
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
    if (preBody.startsWith('[')) {return fullDef;} // Skip complex definitions

    const body = remainder.substring(bodyStart);
    let args = "";
    for(let i=1; i<=argCount; i++) {args += `#${i}`;}

    return `\\def${name}${args}${body}`;
}

/**
 * Helper to extract command name from a definition string.
 * e.g. "\def\foo{...}" -> "\foo"
 */
function extractMacroName(def: string): string | null {
    // Matches \def\name or \newcommand{\name}
    const match = /\\(?:def\s*(\\[a-zA-Z0-9@]+)|(?:re|provide)?newcommand\*?\s*(?:\{(\\[a-zA-Z0-9@]+)\}|(\\[a-zA-Z0-9@]+)))/.exec(def);
    if (match) {
        return match[1] || match[2] || match[3];
    }
    return null;
}

export function extractMetadata(text: string): MetadataResult {
    // 1. Pre-cleaning: Remove comment content but KEEP the % marker.
    // Why? If we remove the whole line, we might create double newlines (\n\n) which split blocks incorrectly.
    // We also keep the % to preserve line counts for sync, but remove content to ensure braces don't break matching.
    let cleanedText = text.replace(/(?<!\\)%.*/gm, '%');

    // =======================================================
    // clean $$$$
    cleanedText = cleanedText.replace(/\$\$\s*\$\$/g, ' ');

    const todayStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    cleanedText = cleanedText.replace(/\\today\b/g, todayStr);

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

    // --- Split Extraction Logic ---
    const tikzGlobalParts: string[] = [];
    const tikzMacroMap = new Map<string, string>();

    // Regex to capture ALL definitions (Global & Macros)
    const defRegex = /\\(provide|re)?(newcommand|def|gdef|DeclareMathOperator|usetikzlibrary|tikzset|definecolor)(\*?)/g;

    let defMatch;
    while ((defMatch = defRegex.exec(cleanedText)) !== null) {
        const startIdx = defMatch.index;
        let openBraces = 0;
        let endIdx = -1;
        let foundStart = false;

        // Brace matching logic
        for (let i = startIdx + defMatch[0].length; i < cleanedText.length; i++) {
             const char = cleanedText[i];
             if (char === '{') {
                 if (!foundStart) {foundStart = true;}
                 openBraces++;
             } else if (char === '}') {
                 openBraces--;
             }
             if (foundStart && openBraces === 0) {
                 let nextIdx = i + 1;
                 while (nextIdx < cleanedText.length && /\s/.test(cleanedText[nextIdx])) {nextIdx++;}
                 if (nextIdx < cleanedText.length && cleanedText[nextIdx] === '{') {
                     i = nextIdx - 1;
                     continue;
                 } else {
                     endIdx = i + 1;
                     break;
                 }
             }
        }

        if (endIdx !== -1) {
             const fullDef = cleanedText.substring(startIdx, endIdx);

             // Check type
             if (/\\(usetikzlibrary|tikzset|definecolor)/.test(fullDef)) {
                 // 1. Global Settings -> Always Keep
                 if (!tikzGlobalParts.includes(fullDef)) {
                     tikzGlobalParts.push(fullDef);
                 }
             } else {
                 // 2. Macros -> Store in Map for On-Demand Injection
                 let finalDef = fullDef;
                 if (/\\(provide|re)?newcommand/.test(fullDef)) {
                     finalDef = transpileToDef(fullDef);
                 }

                 const name = extractMacroName(finalDef);
                 if (name && !tikzMacroMap.has(name)) {
                     tikzMacroMap.set(name, finalDef);
                 }
             }
        }
    }

    const tikzGlobal = tikzGlobalParts.join('\n');

    // Extract KaTeX Macros (Existing Logic)
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
    return { data: { macros, tikzGlobal, tikzMacroMap, title, author, date }, cleanedText };
}