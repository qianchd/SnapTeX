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
                // 忽略 TikZ 等内部环境，防止计数干扰
                if (!/^(proof|itemize|enumerate|tikzpicture)$/.test(beginName)) {
                    // 如果是浮动体开始，且在顶层，强制切分前面的内容
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

                // 【核心修复】浮动体结束时，强制切分块。解决 Figure 吞噬后续内容的问题
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