export interface BlockResult {
    text: string;
    line: number;      // Relative starting line number
    lineCount: number; // Total lines inside this block
}

export class LatexBlockSplitter {
    public static split(text: string): BlockResult[] {
        const blocks: BlockResult[] = [];
        let currentBuffer = "";
        let envStack: string[] = [];
        let braceDepth = 0;

        // Track line numbers
        let currentLine = 0;
        let bufferStartLine = 0;

        // Regex to identify delimiters, environments, and special characters
        const regex = /(?:\\\$|\\\{|\\\})|(?:(?<!\\)%.*)|(\\begin\{([^}]+)\})|(\\end\{([^}]+)\})|(\{)|(\})|(\n\s*\n)|(?<!\\)(\$\$|\\\[|\\\])/g;
        let lastIndex = 0;
        let match;

        while ((match = regex.exec(text)) !== null) {
            // 1. Process text BEFORE the match (plain text between delimiters)
            const preMatch = text.substring(lastIndex, match.index);
            const preLines = (preMatch.match(/\n/g) || []).length;

            currentBuffer += preMatch;
            currentLine += preLines;

            // 2. Process the MATCH itself
            const fullMatch = match[0];
            const matchLines = (fullMatch.match(/\n/g) || []).length;

            const [isBegin, beginName, isEnd, endName, isOpenBrace, isCloseBrace, isDoubleNewline, isMathSymbol] =
                  [match[1], match[2], match[3], match[4], match[5], match[6], match[7], match[8]];

            if (isBegin && beginName) {
                // Ignore internal environments like TikZ to prevent counting interference
                if (!/^(proof|itemize|enumerate|tikzpicture)$/.test(beginName)) {
                    // Force split content before a top-level float
                    // Only split if we are at top level (braceDepth 0) and not already inside another environment
                    if (/^(equation|align|gather|multline|flalign|alignat|figure|table|algorithm)\*?$/.test(beginName) &&
                        envStack.length === 0 && braceDepth === 0) {
                        if (currentBuffer.trim().length > 0) {
                            const count = currentBuffer.split('\n').length;
                            blocks.push({ text: currentBuffer, line: bufferStartLine, lineCount: count });
                            currentBuffer = "";
                            bufferStartLine = currentLine; // Next block starts exactly here
                        }
                    }
                    envStack.push(beginName);
                }
                currentBuffer += fullMatch;
                currentLine += matchLines;
            } else if (isEnd && endName) {
                if (!/^(proof|itemize|enumerate|tikzpicture)$/.test(endName)) {
                    const idx = envStack.lastIndexOf(endName);
                    if (idx !== -1) { envStack = envStack.slice(0, idx); }
                }
                currentBuffer += fullMatch;
                currentLine += matchLines;

                // Force split block when a float ends
                if (/^(figure|table|algorithm)\*?$/.test(endName) && envStack.length === 0 && braceDepth === 0) {
                    if (currentBuffer.trim().length > 0) {
                        const count = currentBuffer.split('\n').length;
                        blocks.push({ text: currentBuffer, line: bufferStartLine, lineCount: count });
                        currentBuffer = "";
                        bufferStartLine = currentLine;
                    }
                }
            } else if (isOpenBrace) {
                braceDepth++;
                currentBuffer += fullMatch;
                currentLine += matchLines;
            } else if (isCloseBrace) {
                braceDepth--;
                currentBuffer += fullMatch;
                currentLine += matchLines;
            } else if (isDoubleNewline) {
                if (envStack.length === 0 && braceDepth === 0) {
                    // Split on double newline (Paragraph break)
                    if (currentBuffer.trim().length > 0) {
                        const count = currentBuffer.split('\n').length;
                        blocks.push({ text: currentBuffer, line: bufferStartLine, lineCount: count });
                        currentBuffer = "";
                    }
                    // The separator (double newline) consumes lines but is not part of the next block
                    // We DO NOT add fullMatch to currentBuffer here, effectively stripping the gap from the block content
                    currentLine += matchLines;
                    bufferStartLine = currentLine;
                } else {
                    currentBuffer += fullMatch;
                    currentLine += matchLines;
                }
            } else if (isMathSymbol) {
                if (fullMatch === '$$' || fullMatch === '\\[' ) {
                    if (envStack.length === 0 && braceDepth === 0) {
                        // Start of display math - check if we should split previous text
                        if (currentBuffer.trim().length > 0) {
                            const count = currentBuffer.split('\n').length;
                            blocks.push({ text: currentBuffer, line: bufferStartLine, lineCount: count });
                            currentBuffer = "";
                            bufferStartLine = currentLine;
                        }
                        envStack.push(fullMatch === '$$' ? '$$' : '\\]');
                    } else if (envStack.length > 0 && envStack[envStack.length - 1] === '$$' && fullMatch === '$$') {
                        envStack.pop();
                    }
                } else if (fullMatch === '\\]') {
                    if (envStack.length > 0 && envStack[envStack.length - 1] === '\\]') { envStack.pop(); }
                }
                currentBuffer += fullMatch;
                currentLine += matchLines;
            } else {
                currentBuffer += fullMatch;
                currentLine += matchLines;
            }
            lastIndex = regex.lastIndex;
        }

        // Handle remaining text
        const remaining = text.substring(lastIndex);
        if (remaining.trim().length > 0) {
             currentBuffer += remaining;
             const count = currentBuffer.split('\n').length;
             blocks.push({ text: currentBuffer, line: bufferStartLine, lineCount: count });
        }

        return blocks;
    }
}