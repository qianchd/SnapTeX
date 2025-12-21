export interface BlockResult {
    text: string;
    line: number;
    lineCount: number;
}

export class LatexBlockSplitter {
    /**
     * Lookahead Heuristic: Search for a matching closing brace within a limit.
     * Purpose: Distinguish between valid multi-paragraph groups (e.g., {\it text \n\n text})
     * and unclosed syntax errors (e.g., {\} text \n\n text).
     */
    private static findClosingBrace(text: string, startIndex: number, currentDepth: number, limitChars: number = 2000): boolean {
        let depth = currentDepth;
        const end = Math.min(text.length, startIndex + limitChars);

        for (let i = startIndex; i < end; i++) {
            const char = text[i];

            // Skip escape sequences (e.g. \{ or \\)
            if (char === '\\') {
                i++;
                continue;
            }

            // Skip comments to avoid false matches
            if (char === '%') {
                const newlineIdx = text.indexOf('\n', i);
                if (newlineIdx === -1) {return false;}
                i = newlineIdx;
                continue;
            }

            if (char === '{') {
                depth++;
            } else if (char === '}') {
                depth--;
                if (depth === 0) {return true;} // Found the closer
            }
        }
        return false; // Limit reached or EOF without closure
    }

    public static split(text: string): BlockResult[] {
        const blocks: BlockResult[] = [];
        let currentBuffer = "";
        let envStack: string[] = [];
        let braceDepth = 0;

        let currentLine = 0;
        let bufferStartLine = 0;

        // Regex matches: escapes, comments, begin/end environments, braces, double newlines, and math delimiters
        const regex = /(?:\\\$|\\\{|\\\})|(?:(?<!\\)%.*)|(\\begin\{([^}]+)\})|(\\end\{([^}]+)\})|(\{)|(\})|(\n\s*\n)|(?<!\\)(\$\$|\\\[|\\\])/g;
        let lastIndex = 0;
        let match;

        while ((match = regex.exec(text)) !== null) {
            // 1. Process plain text before the match
            const preMatch = text.substring(lastIndex, match.index);
            const preLines = (preMatch.match(/\n/g) || []).length;
            currentBuffer += preMatch;
            currentLine += preLines;

            // 2. Process the match
            const fullMatch = match[0];
            const matchLines = (fullMatch.match(/\n/g) || []).length;

            const [isBegin, beginName, isEnd, endName, isOpenBrace, isCloseBrace, isDoubleNewline, isMathSymbol] =
                  [match[1], match[2], match[3], match[4], match[5], match[6], match[7], match[8]];

            // === CRITICAL: Fault Tolerance for Paragraph Breaks ===
            if (isDoubleNewline) {
                let shouldReset = false;

                // Scenario: Inside a brace group (braceDepth > 0) but not a formal environment.
                // Conflict: Valid LaTeX allows {\it \n\n}, but typos like {\} \n\n cause document swallow.
                if (envStack.length === 0 && braceDepth > 0) {
                    // Strategy: Look ahead. If we can't find a closing brace soon (2000 chars),
                    // assume it's a typo and force a reset.
                    const canCloseSoon = LatexBlockSplitter.findClosingBrace(text, regex.lastIndex, braceDepth, 2000);

                    if (canCloseSoon) {
                        // Valid multi-paragraph group: Treat double newline as content.
                        currentBuffer += fullMatch;
                        currentLine += matchLines;
                        lastIndex = regex.lastIndex;
                        continue; // Skip the split logic below
                    } else {
                        // Unlikely to close: Assume error (firewall triggered).
                        shouldReset = true;
                    }
                }

                if (shouldReset) {
                    braceDepth = 0; // Force reset depth to allow splitting
                }

                // Standard Split Logic: Only split if we are at root level (no env, no braces)
                if (envStack.length === 0 && braceDepth === 0) {
                    if (currentBuffer.trim().length > 0) {
                        const count = currentBuffer.split('\n').length;
                        blocks.push({ text: currentBuffer, line: bufferStartLine, lineCount: count });
                        currentBuffer = "";
                    }
                    // Consumes the newline, sets start line for next block
                    currentLine += matchLines;
                    bufferStartLine = currentLine;
                } else {
                    // Inside environment or valid group: Add newline to buffer
                    currentBuffer += fullMatch;
                    currentLine += matchLines;
                }
            }
            // === Standard Token Processing ===
            else if (isBegin && beginName) {
                if (!/^(proof|itemize|enumerate|tikzpicture)$/.test(beginName)) {
                    // Split before top-level floats/equations for better granularity
                    if (/^(equation|align|gather|multline|flalign|alignat|figure|table|algorithm)\*?$/.test(beginName) &&
                        envStack.length === 0 && braceDepth === 0) {
                        if (currentBuffer.trim().length > 0) {
                            const count = currentBuffer.split('\n').length;
                            blocks.push({ text: currentBuffer, line: bufferStartLine, lineCount: count });
                            currentBuffer = "";
                            bufferStartLine = currentLine;
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

                // Split after top-level floats
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
                if (braceDepth > 0) {braceDepth--;}
                currentBuffer += fullMatch;
                currentLine += matchLines;
            } else if (isMathSymbol) {
                 // Math Delimiter Handling ($$, \[, \])
                 if (fullMatch === '$$') {
                    if (envStack.length > 0 && envStack[envStack.length - 1] === '$$') {
                        envStack.pop(); // Close display math
                        currentBuffer += fullMatch;
                    } else if (envStack.length === 0 && braceDepth === 0) {
                        // Check validity using Lookahead (reusing logic for math)
                        const remainingText = text.substring(regex.lastIndex);
                        const nextCloseIdx = remainingText.indexOf('$$');
                        const emptyLineMatch = remainingText.match(/\n\s*\n/);
                        const nextEmptyLineIdx = (emptyLineMatch && typeof emptyLineMatch.index === 'number') ? emptyLineMatch.index : -1;

                        const hasClose = nextCloseIdx !== -1;
                        // Math block is valid only if closed BEFORE the next paragraph break
                        const isBrokenByNewline = nextEmptyLineIdx !== -1 && nextEmptyLineIdx < nextCloseIdx;

                        if (hasClose && !isBrokenByNewline) {
                            // Valid block: Split previous text, start new math block
                             if (currentBuffer.trim().length > 0) {
                                const count = currentBuffer.split('\n').length;
                                blocks.push({ text: currentBuffer, line: bufferStartLine, lineCount: count });
                                currentBuffer = "";
                                bufferStartLine = currentLine;
                            }
                            envStack.push('$$');
                            currentBuffer += fullMatch;
                        } else {
                            // Invalid/Unclosed $$: Treat as plain text to prevent swallow
                            currentBuffer += fullMatch;
                        }
                    } else {
                        currentBuffer += fullMatch;
                    }
                } else if (fullMatch === '\\[') {
                    if (envStack.length === 0 && braceDepth === 0) {
                        if (currentBuffer.trim().length > 0) {
                            const count = currentBuffer.split('\n').length;
                            blocks.push({ text: currentBuffer, line: bufferStartLine, lineCount: count });
                            currentBuffer = "";
                            bufferStartLine = currentLine;
                        }
                        envStack.push('\\]');
                    }
                    currentBuffer += fullMatch;
                } else if (fullMatch === '\\]') {
                    if (envStack.length > 0 && envStack[envStack.length - 1] === '\\]') { envStack.pop(); }
                    currentBuffer += fullMatch;
                }
                currentLine += matchLines;
            } else {
                currentBuffer += fullMatch;
                currentLine += matchLines;
            }
            lastIndex = regex.lastIndex;
        }

        // Handle remaining trailing text
        const remaining = text.substring(lastIndex);
        if (remaining.trim().length > 0) {
             currentBuffer += remaining;
             const count = currentBuffer.split('\n').length;
             blocks.push({ text: currentBuffer, line: bufferStartLine, lineCount: count });
        }

        return blocks;
    }
}