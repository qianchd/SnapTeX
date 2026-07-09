import { extractAstBlockArtifact } from './block-metadata';
import { renderLatexBlockWithAst } from './renderer';
import { splitLatexWithAst } from './splitter';
import { LatexBlockSplitter } from '../splitter';
import type { BlockTextSpan, SplitterOptions } from '../types';
import { getBlockSpanText, stableHash } from '../utils';

interface TimedValue<T> {
    value: T;
    durationMs: number;
}

export interface AstPipelineBenchmarkOptions {
    splitter: SplitterOptions;
    sampleBlockLimit?: number;
}

export interface AstPipelineBenchmarkResult {
    legacySplit: {
        durationMs: number;
        blockCount: number;
    };
    astSplit: {
        durationMs: number;
        blockCount: number;
        largestBlockChars: number;
        largestBlockLines: number;
        parseOk: boolean;
        usedSafetySplit: boolean;
        coarseBlockCount: number;
    };
    astArtifacts: {
        durationMs: number;
        sampledBlocks: number;
    };
    astRender: {
        durationMs: number;
        sampledBlocks: number;
    };
    estimatedDeferredPayloadBytes: number;
    memory: {
        beforeBytes?: number;
        afterBytes?: number;
    };
}

export async function benchmarkAstPipeline(
    text: string,
    options: AstPipelineBenchmarkOptions
): Promise<AstPipelineBenchmarkResult> {
    const beforeBytes = heapUsedBytes();
    const legacySplit = measure(() => LatexBlockSplitter.split(text, options.splitter));
    const astSplit = await measureAsync(() => splitLatexWithAst(text, options.splitter));
    const sampleSpans = astSplit.value.spans.slice(0, options.sampleBlockLimit ?? 20);
    const largestAstBlock = largestBlock(astSplit.value.spans);

    const astArtifacts = await measureAsync(async () => {
        await Promise.all(sampleSpans.map(span => {
            const blockText = getBlockSpanText(text, span);
            return extractAstBlockArtifact(blockText, stableHash(blockText));
        }));
    });
    const astRender = await measureAsync(async () => {
        await Promise.all(sampleSpans.map((span, index) => renderLatexBlockWithAst(getBlockSpanText(text, span), {
            wrapper: {
                index,
                line: span.line,
                lineCount: span.lineCount
            }
        })));
    });

    return {
        legacySplit: {
            durationMs: legacySplit.durationMs,
            blockCount: legacySplit.value.length
        },
        astSplit: {
            durationMs: astSplit.durationMs,
            blockCount: astSplit.value.spans.length,
            largestBlockChars: largestAstBlock.chars,
            largestBlockLines: largestAstBlock.lines,
            parseOk: astSplit.value.parseOk,
            usedSafetySplit: astSplit.value.usedSafetySplit,
            coarseBlockCount: astSplit.value.coarseSpans.length
        },
        astArtifacts: {
            durationMs: astArtifacts.durationMs,
            sampledBlocks: sampleSpans.length
        },
        astRender: {
            durationMs: astRender.durationMs,
            sampledBlocks: sampleSpans.length
        },
        estimatedDeferredPayloadBytes: estimateDeferredPayloadBytes(text, astSplit.value.spans),
        memory: {
            beforeBytes,
            afterBytes: heapUsedBytes()
        }
    };
}

function estimateDeferredPayloadBytes(text: string, spans: readonly BlockTextSpan[]): number {
    return new TextEncoder().encode(JSON.stringify(spans.map((span, index) => ({
        index,
        hash: stableHash(getBlockSpanText(text, span)),
        line: span.line,
        lineCount: span.lineCount
    })))).length;
}

function measure<T>(fn: () => T): TimedValue<T> {
    const startedAt = now();
    const value = fn();
    return {
        value,
        durationMs: now() - startedAt
    };
}

async function measureAsync<T>(fn: () => Promise<T>): Promise<TimedValue<T>> {
    const startedAt = now();
    const value = await fn();
    return {
        value,
        durationMs: now() - startedAt
    };
}

function largestBlock(spans: readonly BlockTextSpan[]): { chars: number; lines: number } {
    return spans.reduce(
        (largest, span) => {
            const chars = Math.max(0, span.end - span.start);
            return chars > largest.chars
                ? { chars, lines: span.lineCount }
                : largest;
        },
        { chars: 0, lines: 0 }
    );
}

function now(): number {
    return globalThis.performance?.now() ?? Date.now();
}

function heapUsedBytes(): number | undefined {
    return typeof process !== 'undefined' && typeof process.memoryUsage === 'function'
        ? process.memoryUsage().heapUsed
        : undefined;
}
