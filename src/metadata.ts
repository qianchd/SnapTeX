import { MetadataResult } from './types';
import { findCommand } from './utils';

export function extractMetadata(text: string): MetadataResult {
    // 1. 预清洗：移除所有注释（%），防止注释里的花括号干扰匹配
    let cleanedText = text.replace(/(?<!\\)%.*/gm, '');

    let title: string | undefined;
    let author: string | undefined;

    // 2. 提取 Title 并从正文中抹除
    const titleRes = findCommand(cleanedText, 'title');
    if (titleRes) {
        title = titleRes.content.replace(/\\\\/g, '<br/>');
        // 物理删除：保留 start 之前和 end 之后的内容
        cleanedText = cleanedText.substring(0, titleRes.start) + cleanedText.substring(titleRes.end + 1);
    }

    // 3. 提取 Author 并从正文中抹除
    const authorRes = findCommand(cleanedText, 'author');
    if (authorRes) {
        author = authorRes.content; // 这里保留原始提取内容，交给 rules.ts 渲染
        // 物理删除：确保整个 \author{...} 块在正文中消失
        cleanedText = cleanedText.substring(0, authorRes.start) + cleanedText.substring(authorRes.end + 1);
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

    return { data: { macros, title, author }, cleanedText };
}