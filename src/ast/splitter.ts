import { DiffEngine } from '../diff';
import {
    findSplitterEnvRule,
    LatexBlockSplitter,
    matchesSplitterEnvRule
} from '../splitter';
import type { BlockTextSpan, SplitterOptions, SplitterRule } from '../types';
import { getBlockSpanText, lineAtOffset, stableHash } from '../utils';
import { parseLatexToAst } from './parse';
import type { AstParseResult, AstSourcePosition, SnaptexAstArgument, SnaptexAstNode } from './types';
import { astNodesRange, environmentName, firstSignificantNode, getSourcePosition, isEnvironmentNode, isMacroNode } from './visit-utils';

export interface AstSplitOptions extends SplitterOptions {
    parse?: (text: string) => Promise<AstParseResult>;
}

export interface AstSplitResult {
    spans: BlockTextSpan[];
    coarseSpans: BlockTextSpan[];
    parseOk: boolean;
    usedSafetySplit: boolean;
}

export interface AstSplitSnapshot {
    text: string;
    spans: readonly BlockTextSpan[];
    coarseSpans?: readonly BlockTextSpan[];
}

interface DecoratorContext {
    start: number;
    end: number;
    prefix: string;
    suffix: string;
}

interface RefineResult {
    spans: BlockTextSpan[];
    parseOk: boolean;
    usedSafetySplit: boolean;
}

interface CoarseBlockMeta {
    span: BlockTextSpan;
    hash: string;
}

/**
 * Experimental two-layer splitter.
 *
 * The legacy splitter first creates cheap coarse spans with its mature recovery
 * behavior. AST parsing then refines only spans that need structural context,
 * such as long style groups or transparent wrapper environments.
 */
export async function splitLatexWithAst(text: string, options: AstSplitOptions): Promise<AstSplitResult> {
    const coarseSpans = createAstCoarseSpans(text, options);
    const refined = await refineCoarseSpans(text, options, coarseSpans);
    return { ...refined, coarseSpans };
}

export async function splitLatexWithAstIncremental(
    text: string,
    options: AstSplitOptions,
    previous?: AstSplitSnapshot
): Promise<AstSplitResult> {
    if (!previous || previous.spans.length === 0 || !previous.coarseSpans || previous.coarseSpans.length === 0) {
        return splitLatexWithAst(text, options);
    }
    if (previous.text === text) {
        return {
            spans: [...previous.spans],
            coarseSpans: [...previous.coarseSpans],
            parseOk: true,
            usedSafetySplit: false
        };
    }

    const coarseSpans = createAstCoarseSpans(text, options);
    const oldCoarse = buildCoarseMeta(previous.text, previous.coarseSpans);
    const newCoarse = buildCoarseMeta(text, coarseSpans);
    const diff = DiffEngine.compute(oldCoarse, newCoarse);
    const spans: BlockTextSpan[] = [];
    let parseOk = true;
    let usedSafetySplit = false;

    const appendReused = (oldIndex: number, newIndex: number) => {
        const oldSpan = oldCoarse[oldIndex]?.span;
        const newSpan = newCoarse[newIndex]?.span;
        if (!oldSpan || !newSpan) { return; }

        const reused = refinedSpansInsideCoarse(previous.spans, oldSpan);
        const offsetDelta = newSpan.start - oldSpan.start;
        const lineDelta = newSpan.line - oldSpan.line;
        spans.push(...(reused.length > 0 ? reused : [oldSpan]).map(span => offsetSpan(span, offsetDelta, lineDelta)));
    };

    for (let index = 0; index < diff.start; index++) {
        appendReused(index, index);
    }

    for (let index = diff.start; index < diff.start + diff.insertCount; index++) {
        const result = await refineCoarseSpan(text, options, coarseSpans[index]);
        spans.push(...result.spans);
        parseOk = parseOk && result.parseOk;
        usedSafetySplit = usedSafetySplit || result.usedSafetySplit;
    }

    const suffixOffset = diff.deleteCount - diff.insertCount;
    for (let index = diff.start + diff.insertCount; index < coarseSpans.length; index++) {
        appendReused(index + suffixOffset, index);
    }

    return {
        spans,
        coarseSpans,
        parseOk,
        usedSafetySplit
    };
}

function createAstCoarseSpans(text: string, options: SplitterOptions): BlockTextSpan[] {
    const coarseSpans = LatexBlockSplitter
        .split(text, options)
        .map(span => trimTransparentContainerEdges(text, span, options.rules))
        .filter((span): span is BlockTextSpan => span !== undefined);
    return mergeWrapperTransparentSpans(text, coarseSpans, options);
}

function buildCoarseMeta(text: string, spans: readonly BlockTextSpan[]): CoarseBlockMeta[] {
    return spans.map(span => ({
        span,
        hash: stableHash(getBlockSpanText(text, span))
    }));
}

async function refineCoarseSpans(
    text: string,
    options: AstSplitOptions,
    coarseSpans: readonly BlockTextSpan[]
): Promise<RefineResult> {
    const spans: BlockTextSpan[] = [];
    let parseOk = true;
    let usedSafetySplit = false;

    for (const coarseSpan of coarseSpans) {
        const result = await refineCoarseSpan(text, options, coarseSpan);
        spans.push(...result.spans);
        parseOk = parseOk && result.parseOk;
        usedSafetySplit = usedSafetySplit || result.usedSafetySplit;
    }

    return { spans, parseOk, usedSafetySplit };
}

async function refineCoarseSpan(text: string, options: AstSplitOptions, coarseSpan: BlockTextSpan): Promise<RefineResult> {
    const source = getBlockSpanText(text, coarseSpan);
    if (!shouldRefineCoarseSpan(source, coarseSpan, options)) {
        return { spans: [coarseSpan], parseOk: true, usedSafetySplit: false };
    }

    const local = await refineTextWithAst(source, options);
    if (local.spans.length === 0 || (!local.parseOk && !local.usedSafetySplit)) {
        return { spans: [coarseSpan], parseOk: local.parseOk, usedSafetySplit: local.usedSafetySplit };
    }

    return {
        spans: local.spans.map(span => offsetSpan(span, coarseSpan.start, coarseSpan.line)),
        parseOk: local.parseOk,
        usedSafetySplit: local.usedSafetySplit
    };
}

function shouldRefineCoarseSpan(text: string, span: BlockTextSpan, options: SplitterOptions): boolean {
    if (text.trim().length === 0) {
        return false;
    }
    if (containsRefinableDecoratorGroup(text, options.rules)) {
        return true;
    }
    if (containsEnvRule(text, options.rules, 'transparent-env')) {
        return true;
    }
    return span.lineCount > options.config.maxBlockLines && !containsEnvRule(text, options.rules, 'no-emergency-split-env');
}

async function refineTextWithAst(text: string, options: AstSplitOptions): Promise<RefineResult> {
    const parseResult = await (options.parse ?? parseLatexToAst)(text);
    if (!parseResult.ast) {
        return { spans: [], parseOk: false, usedSafetySplit: false };
    }
    const parseOk = parseResult.errors.length === 0;

    const spans: BlockTextSpan[] = [];
    let usedSafetySplit = false;
    let blockStart = 0;
    let blockMaxLineCount = options.config.maxNoEmergencySplitLines;
    const resetBlockMaxLineCount = () => {
        blockMaxLineCount = options.config.maxNoEmergencySplitLines;
    };
    const pushAstSpan = (
        start: number,
        end: number,
        contexts: readonly DecoratorContext[] = [],
        maxLineCount = blockMaxLineCount
    ) => {
        usedSafetySplit = pushSpan(spans, text, start, end, options, maxLineCount, contexts) || usedSafetySplit;
    };
    const addWrapperAffixes = (firstSpanIndex: number, prefix: string, suffix: string) => {
        if (spans.length <= firstSpanIndex) {
            return;
        }

        spans[firstSpanIndex] = {
            ...spans[firstSpanIndex],
            prefix: `${spans[firstSpanIndex].prefix ?? ''}${prefix}`
        };
        const lastSpanIndex = spans.length - 1;
        spans[lastSpanIndex] = {
            ...spans[lastSpanIndex],
            suffix: `${suffix}${spans[lastSpanIndex].suffix ?? ''}`
        };
    };
    const processTransparentEnvironment = (
        node: SnaptexAstNode,
        position: AstSourcePosition,
        contexts: readonly DecoratorContext[],
        preserveWrapper: boolean
    ) => {
        pushAstSpan(blockStart, position.start.offset, contexts);
        resetBlockMaxLineCount();

        const innerRange = Array.isArray(node.content) ? astNodesRange(node.content) : undefined;
        if (!innerRange) {
            if (preserveWrapper) {
                pushAstSpan(position.start.offset, position.end.offset, contexts);
            }
            blockStart = position.end.offset;
            return;
        }

        const firstInnerSpanIndex = spans.length;
        blockStart = innerRange.start;
        processNodes(Array.isArray(node.content) ? node.content : [], contexts);
        pushAstSpan(blockStart, innerRange.end, contexts);
        resetBlockMaxLineCount();

        if (preserveWrapper && spans.length === firstInnerSpanIndex) {
            pushAstSpan(position.start.offset, position.end.offset, contexts);
        } else if (preserveWrapper) {
            addWrapperAffixes(
                firstInnerSpanIndex,
                text.slice(position.start.offset, innerRange.start),
                text.slice(innerRange.end, position.end.offset)
            );
        }

        blockStart = position.end.offset;
    };

    const processNodes = (nodes: readonly SnaptexAstNode[], contexts: readonly DecoratorContext[] = []) => {
        for (const node of nodes) {
            const position = getSourcePosition(node);
            if (!position) {
                continue;
            }

            if (node.type === 'parbreak') {
                pushAstSpan(blockStart, position.start.offset, contexts);
                blockStart = position.end.offset;
                resetBlockMaxLineCount();
                continue;
            }

            const decorator = createDecoratorContext(text, node);
            if (decorator) {
                const nestedContexts = [...contexts, decorator];
                processNodes(Array.isArray(node.content) ? node.content : [], nestedContexts);
                if (blockStart > decorator.start && blockStart < decorator.end) {
                    pushAstSpan(blockStart, decorator.end, nestedContexts);
                    blockStart = decorator.end;
                }
                continue;
            }

            if (node.type === 'displaymath') {
                pushAstSpan(blockStart, position.start.offset, contexts);
                resetBlockMaxLineCount();
                blockStart = position.start.offset;
                continue;
            }

            const envName = environmentName(node);
            if (!isEnvironmentNode(node) || !envName) {
                continue;
            }

            const transparentRule = findSplitterEnvRule(options.rules, 'transparent-env', envName);
            if (transparentRule) {
                processTransparentEnvironment(node, position, contexts, transparentRule.preserveWrapper === true);
                continue;
            }

            if (matchesSplitterEnvRule(options.rules, 'split-env', envName)) {
                pushAstSpan(blockStart, position.start.offset, contexts);
                resetBlockMaxLineCount();
                const candidateText = text.slice(position.start.offset, position.end.offset);
                blockMaxLineCount = hasMatchingEnvironmentEnd(candidateText, envName)
                    ? options.config.maxNoEmergencySplitLines
                    : options.config.maxBlockLines;
                blockStart = position.start.offset;
            }
        }
    };

    processNodes(parseResult.ast.content);
    pushAstSpan(blockStart, text.length);
    return {
        spans,
        parseOk,
        usedSafetySplit
    };
}

function refinedSpansInsideCoarse(spans: readonly BlockTextSpan[], coarse: BlockTextSpan): BlockTextSpan[] {
    return spans.filter(span => span.start >= coarse.start && span.end <= coarse.end);
}

function trimTransparentContainerEdges(
    text: string,
    span: BlockTextSpan,
    rules: readonly SplitterRule[]
): BlockTextSpan | undefined {
    let start = span.start;
    let end = span.end;

    while (true) {
        const leading = text.slice(start, end).match(/^\s*\\begin\s*\{([^}]+)\}\s*/);
        if (!leading || !isDroppableTransparentEnv(rules, leading[1])) {
            break;
        }
        start += leading[0].length;
    }

    while (true) {
        const trailing = text.slice(start, end).match(/\s*\\end\s*\{([^}]+)\}\s*$/);
        if (!trailing || !isDroppableTransparentEnv(rules, trailing[1])) {
            break;
        }
        end -= trailing[0].length;
    }

    if (text.slice(start, end).trim().length === 0) {
        return undefined;
    }
    return {
        ...span,
        start,
        end,
        line: lineAtOffset(text, start),
        lineCount: text.slice(start, end).split('\n').length
    };
}

function isDroppableTransparentEnv(rules: readonly SplitterRule[], envName: string): boolean {
    const rule = findSplitterEnvRule(rules, 'transparent-env', envName);
    return Boolean(rule && rule.preserveWrapper !== true);
}

function mergeWrapperTransparentSpans(text: string, spans: readonly BlockTextSpan[], options: SplitterOptions): BlockTextSpan[] {
    const merged: BlockTextSpan[] = [];
    let pending: BlockTextSpan[] = [];
    let balance = 0;
    const maxLines = Math.max(1, Math.floor(options.config.maxNoEmergencySplitLines));

    const flushPending = () => {
        if (pending.length === 0) { return; }
        merged.push(mergeSpans(text, pending));
        pending = [];
        balance = 0;
    };

    for (const span of spans) {
        if (pending.length === 0) {
            const delta = wrapperTransparentEnvBalance(getBlockSpanText(text, span), options.rules);
            if (delta <= 0) {
                merged.push(span);
                continue;
            }
            pending.push(span);
            balance = delta;
        } else {
            pending.push(span);
            balance += wrapperTransparentEnvBalance(getBlockSpanText(text, span), options.rules);
        }

        const lineCount = text.slice(pending[0].start, pending[pending.length - 1].end).split('\n').length;
        if (balance <= 0 || lineCount >= maxLines) {
            flushPending();
        }
    }
    flushPending();
    return merged;
}

function mergeSpans(text: string, spans: readonly BlockTextSpan[]): BlockTextSpan {
    const first = spans[0];
    const last = spans[spans.length - 1];
    return {
        start: first.start,
        end: last.end,
        line: first.line,
        lineCount: text.slice(first.start, last.end).split('\n').length
    };
}

function wrapperTransparentEnvBalance(text: string, rules: readonly SplitterRule[]): number {
    let balance = 0;
    const tokenRegex = /\\(begin|end)\s*\{([^}]+)\}/g;
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(text)) !== null) {
        const rule = findSplitterEnvRule(rules, 'transparent-env', match[2]);
        if (!rule?.preserveWrapper) {
            continue;
        }
        balance += match[1] === 'begin' ? 1 : -1;
    }
    return balance;
}

function containsEnvRule(text: string, rules: readonly SplitterRule[], kind: 'transparent-env' | 'split-env' | 'no-emergency-split-env'): boolean {
    const tokenRegex = /\\(?:begin|end)\s*\{([^}]+)\}/g;
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(text)) !== null) {
        if (findSplitterEnvRule(rules, kind, match[1])) {
            return true;
        }
    }
    return false;
}

function containsRefinableDecoratorGroup(text: string, rules: readonly SplitterRule[]): boolean {
    const openRegex = /\{\\(?:color\{[a-zA-Z0-9]+\}|(?:bf|it|sf|rm|tt)\b)/g;
    let match: RegExpExecArray | null;
    while ((match = openRegex.exec(text)) !== null) {
        if (decoratorGroupNeedsRefinement(text, rules, match.index + 1)) {
            return true;
        }
    }
    return false;
}

function decoratorGroupNeedsRefinement(text: string, rules: readonly SplitterRule[], groupStart: number): boolean {
    let depth = 1;

    for (let index = groupStart + 1; index < text.length; index++) {
        const char = text[index];
        if (char === '\\') {
            const envMatch = text.slice(index).match(/^\\begin\s*\{([^}]+)\}/);
            if (envMatch && matchesSplitterEnvRule(rules, 'split-env', envMatch[1])) {
                return true;
            }
            index += envMatch ? envMatch[0].length - 1 : 1;
            continue;
        }
        if (char === '\n' && /^\n\s*\n/.test(text.slice(index))) {
            return true;
        }
        if (char === '{') {
            depth++;
            continue;
        }
        if (char === '}') {
            depth--;
            if (depth === 0) {
                return false;
            }
            continue;
        }
    }
    return true;
}

function offsetSpan(span: BlockTextSpan, offsetDelta: number, lineDelta: number): BlockTextSpan {
    return {
        ...span,
        start: span.start + offsetDelta,
        end: span.end + offsetDelta,
        line: span.line + lineDelta
    };
}

function createDecoratorContext(text: string, node: SnaptexAstNode): DecoratorContext | undefined {
    if (node.type !== 'group' || !Array.isArray(node.content)) {
        return undefined;
    }

    const groupPosition = getSourcePosition(node);
    const styleMacro = firstSignificantNode(node.content)?.node;
    if (!groupPosition || !styleMacro || !isStyleMacro(styleMacro)) {
        return undefined;
    }

    const styleEnd = nodeEnd(styleMacro);
    if (styleEnd === undefined) {
        return undefined;
    }

    const payloadStart = skipWhitespaceNodes(node.content, styleEnd);
    return {
        start: groupPosition.start.offset,
        end: groupPosition.end.offset,
        prefix: text.slice(groupPosition.start.offset, payloadStart),
        suffix: text.slice(groupPosition.end.offset - 1, groupPosition.end.offset)
    };
}

function isStyleMacro(node: SnaptexAstNode): boolean {
    return isMacroNode(node) && ['color', 'it', 'bf', 'rm', 'sf', 'tt'].includes(node.content);
}

function nodeEnd(node: SnaptexAstNode | SnaptexAstArgument): number | undefined {
    const ends: number[] = [];
    const position = getSourcePosition(node);
    if (position) {
        ends.push(position.end.offset);
    }
    if ('args' in node && Array.isArray(node.args)) {
        for (const argument of node.args) {
            const end = nodeEnd(argument);
            if (end !== undefined) {
                ends.push(end);
            }
        }
    }
    if ('content' in node && Array.isArray(node.content)) {
        const contentEnds: number[] = [];
        for (const child of node.content) {
            const end = nodeEnd(child);
            if (end !== undefined) {
                contentEnds.push(end);
            }
        }
        if (contentEnds.length > 0) {
            const contentEnd = Math.max(...contentEnds);
            ends.push('closeMark' in node && node.closeMark ? contentEnd + node.closeMark.length : contentEnd);
        }
    }
    return ends.length === 0 ? undefined : Math.max(...ends);
}

function skipWhitespaceNodes(nodes: readonly SnaptexAstNode[], offset: number): number {
    let nextOffset = offset;
    for (const node of nodes) {
        const position = getSourcePosition(node);
        if (!position || position.start.offset < nextOffset) {
            continue;
        }
        if (node.type !== 'whitespace') {
            break;
        }
        nextOffset = position.end.offset;
    }
    return nextOffset;
}

function pushSpan(
    spans: BlockTextSpan[],
    text: string,
    start: number,
    end: number,
    options: SplitterOptions,
    maxLineCount: number,
    contexts: readonly DecoratorContext[] = []
): boolean {
    if (start >= end || text.slice(start, end).trim().length === 0) {
        return false;
    }

    const safeMaxLineCount = Math.max(1, Math.floor(maxLineCount));
    const lineCount = text.slice(start, end).split('\n').length;
    if (lineCount > safeMaxLineCount) {
        pushParagraphBudgetSpans(spans, text, start, end, options, safeMaxLineCount, contexts);
        return true;
    }

    spans.push({
        start,
        end,
        line: lineAtOffset(text, start),
        lineCount,
        ...decoratorAffixes(contexts, start, end)
    });
    return false;
}

function decoratorAffixes(contexts: readonly DecoratorContext[], start: number, end: number): Pick<BlockTextSpan, 'prefix' | 'suffix'> {
    const prefix = contexts
        .filter(context => start > context.start && start < context.end)
        .map(context => context.prefix)
        .join('');
    const suffix = contexts
        .filter(context => end > context.start && end < context.end)
        .reverse()
        .map(context => context.suffix)
        .join('');
    return {
        ...(prefix ? { prefix } : {}),
        ...(suffix ? { suffix } : {})
    };
}

function pushParagraphBudgetSpans(
    spans: BlockTextSpan[],
    text: string,
    start: number,
    end: number,
    options: SplitterOptions,
    maxLineCount: number,
    contexts: readonly DecoratorContext[] = []
) {
    let chunkStart = start;
    const boundaryRegex = /\n\s*\n|\\begin\s*\{([^}]+)\}/g;
    boundaryRegex.lastIndex = start;

    const flush = (flushEnd: number) => {
        if (flushEnd > chunkStart) {
            pushLineBudgetSpans(spans, text, chunkStart, flushEnd, maxLineCount, contexts);
        }
    };

    let match: RegExpExecArray | null;
    while ((match = boundaryRegex.exec(text)) !== null && match.index < end) {
        const matchEnd = Math.min(boundaryRegex.lastIndex, end);
        const envName = match[1];
        const isSplitEnv = envName !== undefined && matchesSplitterEnvRule(options.rules, 'split-env', envName);
        if (isSplitEnv && match.index > chunkStart) {
            flush(match.index);
            chunkStart = match.index;
        } else if (envName === undefined) {
            flush(match.index);
            chunkStart = matchEnd;
        }
        if (boundaryRegex.lastIndex > end) {
            break;
        }
    }

    flush(end);
}

function pushLineBudgetSpans(
    spans: BlockTextSpan[],
    text: string,
    start: number,
    end: number,
    maxLineCount: number,
    contexts: readonly DecoratorContext[] = []
) {
    let chunkStart = start;
    let linesInChunk = 1;
    for (let index = start; index < end; index++) {
        if (text[index] !== '\n') {
            continue;
        }
        linesInChunk++;
        if (linesInChunk <= maxLineCount) {
            continue;
        }
        pushRawSpan(spans, text, chunkStart, index, contexts);
        chunkStart = index + 1;
        linesInChunk = 1;
    }
    pushRawSpan(spans, text, chunkStart, end, contexts);
}

function pushRawSpan(
    spans: BlockTextSpan[],
    text: string,
    start: number,
    end: number,
    contexts: readonly DecoratorContext[] = []
) {
    if (start >= end || text.slice(start, end).trim().length === 0) {
        return;
    }

    spans.push({
        start,
        end,
        line: lineAtOffset(text, start),
        lineCount: text.slice(start, end).split('\n').length,
        ...decoratorAffixes(contexts, start, end)
    });
}

function hasMatchingEnvironmentEnd(text: string, envName: string): boolean {
    const escapedName = envName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\\\end\\s*\\{${escapedName}\\}`).test(text);
}
