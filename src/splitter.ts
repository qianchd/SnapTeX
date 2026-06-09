import { REGEX_STR } from './patterns';
import { BlockTextSpan } from './types';
import { scanLatexBraceBalance } from './utils';

/**
 * Splits cleaned LaTeX body text into preview blocks.
 *
 * The splitter prefers paragraph and environment boundaries, but it can recover
 * from unmatched braces/environments so one broken area does not trap the rest
 * of the document in a single block. TikZ pictures are exempt from max-line
 * emergency splitting because they are compiled as one unit.
 */
export class LatexBlockSplitter {
    public static split(text: string, maxLines: number = 40): BlockTextSpan[] {
        const blocks: BlockTextSpan[] = [];
        let currentBuffer = "";
        let envStack: string[] = [];
        let braceDepth = 0;

        let currentLine = 0;
        let bufferStartLine = 0;
        let bufferStartIndex = 0;

        const pushCurrentBlock = (endIndex: number) => {
            if (currentBuffer.trim().length === 0) { return; }
            const count = currentBuffer.split('\n').length;
            blocks.push({
                start: bufferStartIndex,
                end: endIndex,
                line: bufferStartLine,
                lineCount: count
            });
            currentBuffer = "";
        };
        const startNextBlock = (line: number, index: number) => {
            bufferStartLine = line;
            bufferStartIndex = index;
        };
        const pushCurrentBlockAndStartAt = (endIndex: number, startLine: number, startIndex: number) => {
            pushCurrentBlock(endIndex);
            startNextBlock(startLine, startIndex);
        };

        const regex = /(?:\\\$|\\\{|\\\})|(?:(?<!\\)%.*)|(\\begin\{([^}]+)\})|(\\end\{([^}]+)\})|(\{)|(\})|(\n\s*\n)|(?<!\\)(\$\$|\\\[|\\\])/g;
        let lastIndex = 0;
        let match;

        const ignoredEnvRegex = new RegExp(`^(${REGEX_STR.SPLITTER_IGNORED})$`);
        const majorEnvRegex = new RegExp(`^(${REGEX_STR.SPLITTER_MAJOR})\\*?$`);
        const mathEnvRegex = new RegExp(`^(${REGEX_STR.MATH_ENVS})\\*?$`);

        while ((match = regex.exec(text)) !== null) {
            const preMatch = text.substring(lastIndex, match.index);
            const preLines = (preMatch.match(/\n/g) || []).length;
            currentBuffer += preMatch;
            currentLine += preLines;

            const fullMatch = match[0];
            const matchLines = (fullMatch.match(/\n/g) || []).length;

            const [isBegin, beginName, isEnd, endName, isOpenBrace, isCloseBrace, isDoubleNewline, isMathSymbol] =
                  [match[1], match[2], match[3], match[4], match[5], match[6], match[7], match[8]];

            const currentBufferLineCount = (currentBuffer.match(/\n/g) || []).length;

            const hasTikzPictureInBuffer = /\\begin\{tikzpicture\}/.test(currentBuffer);
            const isInsideTikzPicture = envStack.includes('tikzpicture');
            const isTrapped = currentBufferLineCount >= maxLines && !isInsideTikzPicture && !hasTikzPictureInBuffer;

            if (isDoubleNewline) {
                let shouldReset = false;

                if (envStack.length === 0 && braceDepth > 0) {
                    const canCloseSoon = scanLatexBraceBalance(text, {
                        start: regex.lastIndex,
                        initialDepth: braceDepth,
                        limitChars: 2000,
                        stopWhenClosed: true,
                        commentMode: 'skip-line'
                    }).closedAt !== undefined;
                    if (!canCloseSoon) { shouldReset = true; }
                }

                if (isTrapped && (envStack.length > 0 || braceDepth > 0)) {
                    shouldReset = true;
                }

                if (shouldReset) {
                    braceDepth = 0;
                    envStack = [];
                }

                if (envStack.length === 0 && braceDepth === 0) {
                    pushCurrentBlock(match.index);
                    currentLine += matchLines;
                    startNextBlock(currentLine, regex.lastIndex);
                } else {
                    currentBuffer += fullMatch;
                    currentLine += matchLines;
                }
            }
            else if (isBegin && beginName) {
                const isIgnoredEnv = ignoredEnvRegex.test(beginName);

                if (!isIgnoredEnv) {
                    const isMajorEnv = majorEnvRegex.test(beginName);

                    if (isMajorEnv && (envStack.length === 0 && braceDepth === 0 || isTrapped)) {
                          if (currentBuffer.trim().length > 0) {
                            pushCurrentBlockAndStartAt(match.index, currentLine, match.index);
                            if (isTrapped) { envStack = []; braceDepth = 0; }
                        }
                    }
                    envStack.push(beginName);
                }
                currentBuffer += fullMatch;
                currentLine += matchLines;
            }
            else if (isEnd && endName) {
                const isIgnoredEnv = ignoredEnvRegex.test(endName);
                if (!isIgnoredEnv) {
                    const idx = envStack.lastIndexOf(endName);
                    if (idx !== -1) { envStack = envStack.slice(0, idx); }
                }
                currentBuffer += fullMatch;
                currentLine += matchLines;

                const isMathEnv = mathEnvRegex.test(endName);
                if (isMathEnv && isTrapped) {
                    if (currentBuffer.trim().length > 0) {
                        pushCurrentBlockAndStartAt(regex.lastIndex, currentLine, regex.lastIndex);
                        envStack = [];
                        braceDepth = 0;
                    }
                }
            }
            else if (isOpenBrace) {
                braceDepth++;
                currentBuffer += fullMatch;
                currentLine += matchLines;
            } else if (isCloseBrace) {
                if (braceDepth > 0) {braceDepth--;}
                currentBuffer += fullMatch;
                currentLine += matchLines;
            }
            else if (isMathSymbol) {
                 if (fullMatch === '$$') {
                    if (envStack.length > 0 && envStack[envStack.length - 1] === '$$') {
                        envStack.pop();
                        currentBuffer += fullMatch;
                    } else if ((envStack.length === 0 && braceDepth === 0) || isTrapped) {
                        const remainingText = text.substring(regex.lastIndex);
                        const nextCloseIdx = remainingText.indexOf('$$');
                        const emptyLineMatch = remainingText.match(/\n\s*\n/);
                        const nextEmptyLineIdx = (emptyLineMatch && typeof emptyLineMatch.index === 'number') ? emptyLineMatch.index : -1;

                        const hasClose = nextCloseIdx !== -1;
                        const isBrokenByNewline = nextEmptyLineIdx !== -1 && (nextCloseIdx === -1 || nextEmptyLineIdx < nextCloseIdx);

                        if ((hasClose && !isBrokenByNewline) || isTrapped) {
                              if (!isTrapped && currentBuffer.trim().length > 0) {
                                pushCurrentBlockAndStartAt(match.index, currentLine, match.index);
                            }
                            envStack.push('$$');
                            currentBuffer += fullMatch;
                        } else {
                            currentBuffer += fullMatch;

                            if (currentBuffer.trim().length > 0) {
                                pushCurrentBlockAndStartAt(regex.lastIndex, currentLine + matchLines, regex.lastIndex);
                            }
                        }
                    } else {
                        currentBuffer += fullMatch;
                    }
                } else if (fullMatch === '\\[') {
                    if ((envStack.length === 0 && braceDepth === 0) || isTrapped) {
                        if (!isTrapped && currentBuffer.trim().length > 0) {
                            pushCurrentBlockAndStartAt(match.index, currentLine, match.index);
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

        const remaining = text.substring(lastIndex);
        if (remaining.length > 0) {
             currentBuffer += remaining;
        }
        pushCurrentBlock(text.length);

        return blocks;
    }
}
