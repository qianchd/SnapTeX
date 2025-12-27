import { REGEX_STR } from './patterns';

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
            if (char === '\\') { i++; continue; }
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
                if (depth === 0) {return true;}
            }
        }
        return false;
    }

    /**
     * Split Logic:
     * 1. Respect structure: Never split in the middle of a sentence/paragraph just because of line count.
     * 2. Fault Tolerance: If a block exceeds `maxLines` while inside a protected environment ({...}, \begin...),
     * assume the protection is a typo/unclosed syntax and ALLOW splits at natural boundaries (\n\n, \begin).
     * 3. Proofs: Treat as plain text (ignoring protection), naturally split-able.
     */
    public static split(text: string, maxLines: number = 40): BlockResult[] {
        const blocks: BlockResult[] = [];
        let currentBuffer = "";
        let envStack: string[] = [];
        let braceDepth = 0;

        let currentLine = 0;
        let bufferStartLine = 0;

        const regex = /(?:\\\$|\\\{|\\\})|(?:(?<!\\)%.*)|(\\begin\{([^}]+)\})|(\\end\{([^}]+)\})|(\{)|(\})|(\n\s*\n)|(?<!\\)(\$\$|\\\[|\\\])/g;
        let lastIndex = 0;
        let match;

        // Pre-compile regex for performance inside loop
        const ignoredEnvRegex = new RegExp(`^(${REGEX_STR.SPLITTER_IGNORED})$`);
        const majorEnvRegex = new RegExp(`^(${REGEX_STR.SPLITTER_MAJOR})\\*?$`);

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

            // Calculate current buffer size to decide on "Emergency Split" logic
            const currentBufferLineCount = (currentBuffer.match(/\n/g) || []).length;

            // Logic: If buffer is too huge, we assume we are trapped in an unclosed environment.
            // We treat 'isTrapped' as a signal to behave as if depth is 0.
            const isTrapped = currentBufferLineCount >= maxLines;

            // === A. Handle Paragraph Breaks (\n\n) ===
            if (isDoubleNewline) {
                let shouldReset = false;

                // Case 1: Standard Typo Check (Unclosed brace near a double newline)
                if (envStack.length === 0 && braceDepth > 0) {
                    const canCloseSoon = LatexBlockSplitter.findClosingBrace(text, regex.lastIndex, braceDepth, 2000);
                    if (!canCloseSoon) { shouldReset = true; }
                }

                // Case 2: MaxLines Exceeded Check
                // If we are over maxLines, we force a reset of the stack/depth effectively ignores the unclosed layer.
                if (isTrapped && (envStack.length > 0 || braceDepth > 0)) {
                    shouldReset = true;
                }

                if (shouldReset) {
                    braceDepth = 0;
                    envStack = []; // Reset stack to allow recovery from unclosed \begin
                }

                // Split Condition: Root level OR forced reset
                if (envStack.length === 0 && braceDepth === 0) {
                    if (currentBuffer.trim().length > 0) {
                        const count = currentBuffer.split('\n').length;
                        blocks.push({ text: currentBuffer, line: bufferStartLine, lineCount: count });
                        currentBuffer = "";
                    }
                    currentLine += matchLines;
                    bufferStartLine = currentLine;
                } else {
                    // Valid multi-paragraph group: Keep accumulating
                    currentBuffer += fullMatch;
                    currentLine += matchLines;
                }
            }
            // === B. Handle \begin{...} ===
            else if (isBegin && beginName) {
                // Determine if this environment is "Ignored" (Proof) or "Protected"
                const isIgnoredEnv = ignoredEnvRegex.test(beginName);

                if (!isIgnoredEnv) {
                    // Split Strategy for Major Environments (Equation, Table, etc.)
                    // Normal: Only split if depth is 0.
                    // Trapped: If buffer is huge, split anyway (assuming previous context was broken).
                    const isMajorEnv = majorEnvRegex.test(beginName);

                    if (isMajorEnv && (envStack.length === 0 && braceDepth === 0 || isTrapped)) {
                         if (currentBuffer.trim().length > 0) {
                            const count = currentBuffer.split('\n').length;
                            blocks.push({ text: currentBuffer, line: bufferStartLine, lineCount: count });
                            currentBuffer = "";
                            bufferStartLine = currentLine;
                            // If we were trapped, the flush effectively resets our context for the new block
                            if (isTrapped) { envStack = []; braceDepth = 0; }
                        }
                    }
                    envStack.push(beginName);
                }
                currentBuffer += fullMatch;
                currentLine += matchLines;
            }
            // === C. Handle \end{...} ===
            else if (isEnd && endName) {
                const isIgnoredEnv = ignoredEnvRegex.test(endName);
                if (!isIgnoredEnv) {
                    const idx = envStack.lastIndexOf(endName);
                    if (idx !== -1) { envStack = envStack.slice(0, idx); }
                }
                currentBuffer += fullMatch;
                currentLine += matchLines;

                // Split after Major Environments
                // Trapped Logic: If we are trapped, we might want to forcefully split after a major env closes
                const isMajorEnv = majorEnvRegex.test(endName);
                if (isMajorEnv && (envStack.length === 0 && braceDepth === 0 || isTrapped)) {
                    if (currentBuffer.trim().length > 0) {
                        const count = currentBuffer.split('\n').length;
                        blocks.push({ text: currentBuffer, line: bufferStartLine, lineCount: count });
                        currentBuffer = "";
                        bufferStartLine = currentLine;
                        if (isTrapped) { envStack = []; braceDepth = 0; }
                    }
                }
            }
            // === D. Handle Braces ===
            else if (isOpenBrace) {
                braceDepth++;
                currentBuffer += fullMatch;
                currentLine += matchLines;
            } else if (isCloseBrace) {
                if (braceDepth > 0) {braceDepth--;}
                currentBuffer += fullMatch;
                currentLine += matchLines;
            }
            // === E. Handle Math ($$, \[, \]) ===
            else if (isMathSymbol) {
                 if (fullMatch === '$$') {
                    if (envStack.length > 0 && envStack[envStack.length - 1] === '$$') {
                        // 正常闭合 $$
                        envStack.pop();
                        currentBuffer += fullMatch;
                    } else if ((envStack.length === 0 && braceDepth === 0) || isTrapped) {
                        // Lookahead check
                        const remainingText = text.substring(regex.lastIndex);
                        const nextCloseIdx = remainingText.indexOf('$$');
                        const emptyLineMatch = remainingText.match(/\n\s*\n/);
                        const nextEmptyLineIdx = (emptyLineMatch && typeof emptyLineMatch.index === 'number') ? emptyLineMatch.index : -1;

                        const hasClose = nextCloseIdx !== -1;
                        // 修正逻辑：如果中间有空行，且空行在闭合符号之前（或者根本没闭合），视为断裂
                        const isBrokenByNewline = nextEmptyLineIdx !== -1 && (nextCloseIdx === -1 || nextEmptyLineIdx < nextCloseIdx);

                        // Valid if closed properly OR if we are already in a trapped state (just consume it)
                        if ((hasClose && !isBrokenByNewline) || isTrapped) {
                             // 如果不是 trapped 状态，且之前有文本，先切分之前的文本
                             if (!isTrapped && currentBuffer.trim().length > 0) {
                                const count = currentBuffer.split('\n').length;
                                blocks.push({ text: currentBuffer, line: bufferStartLine, lineCount: count });
                                currentBuffer = "";
                                bufferStartLine = currentLine;
                            }
                            envStack.push('$$');
                            currentBuffer += fullMatch;
                        } else {
                            // === [修复核心] 无效/未闭合的 $$ ===
                            // 我们将其附加到当前 buffer，然后立即强制切分。
                            // 这样这个错误的 $$ 就会被“隔离”在上一个块的末尾，而不会污染下一个块。
                            currentBuffer += fullMatch;

                            if (currentBuffer.trim().length > 0) {
                                const count = currentBuffer.split('\n').length;
                                blocks.push({ text: currentBuffer, line: bufferStartLine, lineCount: count });
                                currentBuffer = "";
                                // 下一个块从当前位置之后开始
                                bufferStartLine = currentLine + matchLines;
                            }
                        }
                    } else {
                        currentBuffer += fullMatch;
                    }
                } else if (fullMatch === '\\[') {
                    // Logic similar to $$: Split before block math if possible
                    if ((envStack.length === 0 && braceDepth === 0) || isTrapped) {
                        if (!isTrapped && currentBuffer.trim().length > 0) {
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

        // Handle remaining
        const remaining = text.substring(lastIndex);
        if (remaining.trim().length > 0) {
             currentBuffer += remaining;
             const count = currentBuffer.split('\n').length;
             blocks.push({ text: currentBuffer, line: bufferStartLine, lineCount: count });
        }

        return blocks;
    }
}