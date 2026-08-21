import { BlockTextSpan, SplitterOptions, SplitterRule } from './types';
import { countLineBreaks, scanLatexBraceBalance } from './utils';

type SplitterEnvRule = Extract<SplitterRule, { envPattern: RegExp }>;
type SplitterEnvRuleKind = SplitterEnvRule['kind'];
type SplitterContextWrapperRule = Extract<SplitterRule, { kind: 'context-wrapper' }>;

function testPattern(pattern: RegExp, value: string): boolean {
    pattern.lastIndex = 0;
    const matched = pattern.test(value);
    pattern.lastIndex = 0;
    return matched;
}

export function findSplitterEnvRule<K extends SplitterEnvRuleKind>(
    rules: readonly SplitterRule[],
    kind: K,
    envName: string
): Extract<SplitterEnvRule, { kind: K }> | undefined {
    return rules.find((rule): rule is Extract<SplitterEnvRule, { kind: K }> =>
        rule.kind === kind && 'envPattern' in rule && testPattern(rule.envPattern, envName)
    );
}

export function matchesSplitterEnvRule(rules: readonly SplitterRule[], kind: SplitterEnvRuleKind, envName: string): boolean {
    return findSplitterEnvRule(rules, kind, envName) !== undefined;
}

export function findSplitterContextWrapperRule(
    rules: readonly SplitterRule[],
    macroName: string
): SplitterContextWrapperRule | undefined {
    return rules.find((rule): rule is SplitterContextWrapperRule =>
        rule.kind === 'context-wrapper' && testPattern(rule.macroPattern, macroName)
    );
}

function containsArgumentContextWrapper(text: string, rules: readonly SplitterRule[]): boolean {
    const macroPattern = /(?<!\\)\\([a-zA-Z@]+)/g;
    let match: RegExpExecArray | null;
    while ((match = macroPattern.exec(text)) !== null) {
        const rule = findSplitterContextWrapperRule(rules, match[1]);
        if (rule && rule.content !== 'group-remainder') {
            return true;
        }
    }
    return false;
}

/**
 * Splits cleaned LaTeX body text into preview blocks.
 *
 * The splitter prefers paragraph and environment boundaries, but it can recover
 * from unmatched braces/environments so one broken area does not trap the rest
 * of the document in a single block. Registry splitter rules declare which
 * environments or brace groups should resist emergency splitting.
 */
export class LatexBlockSplitter {
    public static split(text: string, options: SplitterOptions): BlockTextSpan[] {
        const blocks: BlockTextSpan[] = [];
        let hasBufferedContent = false;
        let currentBlockLineBreaks = 0;
        let envStack: string[] = [];
        let braceDepth = 0;
        let hasContextWrapperStart = false;
        const maxBlockLines = Math.max(1, Math.floor(options.config.maxBlockLines));
        const maxNoEmergencySplitLines = Math.max(maxBlockLines, Math.floor(options.config.maxNoEmergencySplitLines));

        let currentLine = 0;
        let bufferStartLine = 0;
        let bufferStartIndex = 0;

        const advanceCurrentBlock = (value: string, lineBreaks = countLineBreaks(value)) => {
            hasBufferedContent ||= value.trim().length > 0;
            currentBlockLineBreaks += lineBreaks;
            currentLine += lineBreaks;
        };
        const pushCurrentBlock = (endIndex: number) => {
            if (hasBufferedContent) {
                blocks.push({
                    start: bufferStartIndex,
                    end: endIndex,
                    line: bufferStartLine,
                    lineCount: currentBlockLineBreaks + 1
                });
            }
            hasBufferedContent = false;
            currentBlockLineBreaks = 0;
        };
        const startNextBlock = (line: number, index: number) => {
            bufferStartLine = line;
            bufferStartIndex = index;
            hasContextWrapperStart = false;
        };
        const pushCurrentBlockAndStartAt = (endIndex: number, startLine: number, startIndex: number) => {
            pushCurrentBlock(endIndex);
            startNextBlock(startLine, startIndex);
        };

        const regex = /(?:\\\$|\\\{|\\\})|(?:(?<!\\)%.*)|(\\begin\{([^}]+)\})|(\\end\{([^}]+)\})|(\{)|(\})|(\n\s*\n)|(?<!\\)(\$\$|\\\[|\\\])/g;
        let lastIndex = 0;
        let match;

        while ((match = regex.exec(text)) !== null) {
            const preMatch = text.substring(lastIndex, match.index);
            advanceCurrentBlock(preMatch);
            hasContextWrapperStart ||= containsArgumentContextWrapper(preMatch, options.rules);

            const fullMatch = match[0];
            const matchLines = countLineBreaks(fullMatch);

            const [isBegin, beginName, isEnd, endName, isOpenBrace, isCloseBrace, isDoubleNewline, isMathSymbol] =
                  [match[1], match[2], match[3], match[4], match[5], match[6], match[7], match[8]];

            const withinNoEmergencySplitBudget = currentBlockLineBreaks <= maxNoEmergencySplitLines;
            const hasNoEmergencySplitProtectionInBuffer = withinNoEmergencySplitBudget && hasContextWrapperStart;
            const isInsideNoEmergencySplitEnv = withinNoEmergencySplitBudget
                && envStack.some(envName => matchesSplitterEnvRule(options.rules, 'no-emergency-split-env', envName));
            const isTrapped = currentBlockLineBreaks >= maxBlockLines
                && !isInsideNoEmergencySplitEnv
                && !hasNoEmergencySplitProtectionInBuffer;

            if (isDoubleNewline) {
                let shouldReset = false;

                if (envStack.length === 0 && braceDepth > 0 && !hasNoEmergencySplitProtectionInBuffer) {
                    const canCloseSoon = scanLatexBraceBalance(text, {
                        start: regex.lastIndex,
                        initialDepth: braceDepth,
                        limitChars: 2000,
                        stopWhenClosed: true,
                        commentMode: 'skip-line'
                    }).closedAt !== undefined;
                    if (!canCloseSoon) { shouldReset = true; }
                }

                if (isTrapped && (envStack.length > 0 || braceDepth > 0) && !hasNoEmergencySplitProtectionInBuffer) {
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
                    advanceCurrentBlock(fullMatch, matchLines);
                }
            }
            else if (isBegin && beginName) {
                const isIgnoredEnv = matchesSplitterEnvRule(options.rules, 'ignored-env', beginName);

                if (!isIgnoredEnv) {
                    const isMajorEnv = matchesSplitterEnvRule(options.rules, 'split-env', beginName);
                    const beginsNoEmergencySplitEnv = matchesSplitterEnvRule(options.rules, 'no-emergency-split-env', beginName);

                    if (isMajorEnv && (envStack.length === 0 && braceDepth === 0 || isTrapped && !beginsNoEmergencySplitEnv)) {
                        if (hasBufferedContent) {
                            pushCurrentBlockAndStartAt(match.index, currentLine, match.index);
                            if (isTrapped) { envStack = []; braceDepth = 0; }
                        }
                    }
                    envStack.push(beginName);
                }
                advanceCurrentBlock(fullMatch, matchLines);
            }
            else if (isEnd && endName) {
                const isIgnoredEnv = matchesSplitterEnvRule(options.rules, 'ignored-env', endName);
                if (!isIgnoredEnv) {
                    const idx = envStack.lastIndexOf(endName);
                    if (idx !== -1) { envStack = envStack.slice(0, idx); }
                }
                advanceCurrentBlock(fullMatch, matchLines);

                const isEmergencySplitEndEnv = matchesSplitterEnvRule(options.rules, 'emergency-split-end-env', endName);
                if (isEmergencySplitEndEnv && isTrapped) {
                    if (hasBufferedContent) {
                        pushCurrentBlockAndStartAt(regex.lastIndex, currentLine, regex.lastIndex);
                        envStack = [];
                        braceDepth = 0;
                    }
                }
            }
            else if (isOpenBrace) {
                const macroName = text.slice(regex.lastIndex).match(/^\s*\\([a-zA-Z@]+)/)?.[1];
                const wrapperRule = macroName ? findSplitterContextWrapperRule(options.rules, macroName) : undefined;
                if (wrapperRule?.content === 'group-remainder') {
                    hasContextWrapperStart = true;
                }
                braceDepth++;
                advanceCurrentBlock(fullMatch, matchLines);
            } else if (isCloseBrace) {
                if (braceDepth > 0) {braceDepth--;}
                advanceCurrentBlock(fullMatch, matchLines);
            }
            else if (isMathSymbol) {
                 if (fullMatch === '$$') {
                    if (envStack.length > 0 && envStack[envStack.length - 1] === '$$') {
                        envStack.pop();
                        advanceCurrentBlock(fullMatch, matchLines);
                    } else if ((envStack.length === 0 && braceDepth === 0) || isTrapped) {
                        const remainingText = text.substring(regex.lastIndex);
                        const nextCloseIdx = remainingText.indexOf('$$');
                        const emptyLineMatch = remainingText.match(/\n\s*\n/);
                        const nextEmptyLineIdx = (emptyLineMatch && typeof emptyLineMatch.index === 'number') ? emptyLineMatch.index : -1;

                        const hasClose = nextCloseIdx !== -1;
                        const isBrokenByNewline = nextEmptyLineIdx !== -1 && (nextCloseIdx === -1 || nextEmptyLineIdx < nextCloseIdx);

                        if ((hasClose && !isBrokenByNewline) || isTrapped) {
                              if (!isTrapped && hasBufferedContent) {
                                pushCurrentBlockAndStartAt(match.index, currentLine, match.index);
                            }
                            envStack.push('$$');
                            advanceCurrentBlock(fullMatch, matchLines);
                        } else {
                            advanceCurrentBlock(fullMatch, matchLines);

                            if (hasBufferedContent) {
                                pushCurrentBlockAndStartAt(regex.lastIndex, currentLine, regex.lastIndex);
                            }
                        }
                    } else {
                        advanceCurrentBlock(fullMatch, matchLines);
                    }
                } else if (fullMatch === '\\[') {
                    if ((envStack.length === 0 && braceDepth === 0) || isTrapped) {
                        if (!isTrapped && hasBufferedContent) {
                            pushCurrentBlockAndStartAt(match.index, currentLine, match.index);
                        }
                        envStack.push('\\]');
                    }
                    advanceCurrentBlock(fullMatch, matchLines);
                } else if (fullMatch === '\\]') {
                    if (envStack.length > 0 && envStack[envStack.length - 1] === '\\]') { envStack.pop(); }
                    advanceCurrentBlock(fullMatch, matchLines);
                }
            } else {
                advanceCurrentBlock(fullMatch, matchLines);
            }
            lastIndex = regex.lastIndex;
        }

        const remaining = text.substring(lastIndex);
        if (remaining.length > 0) {
             advanceCurrentBlock(remaining);
        }
        pushCurrentBlock(text.length);

        return blocks;
    }
}
