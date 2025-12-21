export class LatexBlockSplitter {
    public static split(text: string): string[] {
        const blocks: string[] = [];
        let currentBuffer = "";
        let envStack: string[] = [];
        let braceDepth = 0;

        const regex = /(?:\\\$|\\\{|\\\})|(?:(?<!\\)%.*)|(\\begin\{([^}]+)\})|(\\end\{([^}]+)\})|(\{)|(\})|(\n\s*\n)|(?<!\\)(\$\$|\\\[|\\\])/g;
        let lastIndex = 0;
        let match;

        while ((match = regex.exec(text)) !== null) {
            currentBuffer += text.substring(lastIndex, match.index);
            const fullMatch = match[0];
            const [isBegin, beginName, isEnd, endName, isOpenBrace, isCloseBrace, isDoubleNewline, isMathSymbol] =
                  [match[1], match[2], match[3], match[4], match[5], match[6], match[7], match[8]];

            if (isBegin && beginName) {
                // Ignore internal environments like TikZ to prevent counting interference
                if (!/^(proof|itemize|enumerate|tikzpicture)$/.test(beginName)) {
                    // If it is the start of a float and at the top level, force split the preceding content
                    if (/^(equation|align|gather|multline|flalign|alignat|figure|table|algorithm)\*?$/.test(beginName) &&
                        envStack.length === 0 && braceDepth === 0) {
                        if (currentBuffer.trim().length > 0) {
                            blocks.push(currentBuffer);
                            currentBuffer = "";
                        }
                    }
                    envStack.push(beginName);
                }
                currentBuffer += fullMatch;
            } else if (isEnd && endName) {
                if (!/^(proof|itemize|enumerate|tikzpicture)$/.test(endName)) {
                    const idx = envStack.lastIndexOf(endName);
                    if (idx !== -1) { envStack = envStack.slice(0, idx); }
                }
                currentBuffer += fullMatch;

                // [Core Fix] Force split the block when a float ends. Solves the issue where Figure swallows subsequent content
                if (/^(figure|table|algorithm)\*?$/.test(endName) && envStack.length === 0 && braceDepth === 0) {
                    if (currentBuffer.trim().length > 0) {
                        blocks.push(currentBuffer);
                        currentBuffer = "";
                    }
                }
            } else if (isOpenBrace) { braceDepth++; currentBuffer += fullMatch; }
            else if (isCloseBrace) { braceDepth--; currentBuffer += fullMatch; }
            else if (isDoubleNewline) {
                if (envStack.length === 0 && braceDepth === 0) {
                    if (currentBuffer.trim().length > 0) { blocks.push(currentBuffer); currentBuffer = ""; }
                } else { currentBuffer += fullMatch; }
            } else if (isMathSymbol) {
                if (fullMatch === '$$' || fullMatch === '\\[' ) {
                    if (envStack.length === 0 && braceDepth === 0) {
                        if (currentBuffer.trim().length > 0) { blocks.push(currentBuffer); currentBuffer = ""; }
                        envStack.push(fullMatch === '$$' ? '$$' : '\\]');
                    } else if (envStack.length > 0 && envStack[envStack.length - 1] === '$$' && fullMatch === '$$') {
                        envStack.pop();
                    }
                } else if (fullMatch === '\\]') {
                    if (envStack.length > 0 && envStack[envStack.length - 1] === '\\]') { envStack.pop(); }
                }
                currentBuffer += fullMatch;
            } else { currentBuffer += fullMatch; }
            lastIndex = regex.lastIndex;
        }
        currentBuffer += text.substring(lastIndex);
        if (currentBuffer.trim().length > 0) { blocks.push(currentBuffer); }
        return blocks;
    }
}