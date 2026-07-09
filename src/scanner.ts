import { DiffEngine } from './diff';
import { REGEX_STR } from './patterns';
import { BlockNumberingCounts } from './types';
import { extractLatexLabelNames, stableHash } from './utils';

export interface BlockNumbering {
    counts: BlockNumberingCounts;
}

export interface ScanResult {
    blockNumbering: BlockNumbering[];
    labelMap: Record<string, string>;
}

export interface BlockTextProvider {
    getBlockCount(): number;
    getBlockText(index: number): string | undefined;
    getBlockHash(index: number): string | undefined;
}

export interface LatexScanner {
    scan(provider: BlockTextProvider): ScanResult;
}

export type SectionLevel = 'section' | 'subsection' | 'subsubsection' | 'paragraph' | 'subparagraph';
export type FloatKind = 'fig' | 'tbl' | 'alg';

export type ScanToken =
    | { pos: number; kind: 'sec'; level: SectionLevel; label?: string }
    | { pos: number; kind: 'eq'; label?: string; labels?: string[]; tag?: string }
    | { pos: number; kind: 'float'; floatKind: FloatKind; label?: string; labels?: string[] }
    | { pos: number; kind: 'thm'; envName: string; label?: string; labels?: string[] };

export interface BlockScanSummary {
    hash: string;
    tokens: ScanToken[];
}

interface CounterState {
    sec: number;
    subsec: number;
    subsubsec: number;
    eq: number;
    fig: number;
    tbl: number;
    alg: number;
}

function createEmptyBlockNumbering(): BlockNumbering {
    return {
        counts: { eq: [], fig: [], tbl: [], alg: [], sec: [], thm: [] }
    };
}

function assignLabels(labelMap: Record<string, string>, token: { label?: string; labels?: string[] }, value: string) {
    const labels = token.labels ?? (token.label ? [token.label] : []);
    labels.forEach(label => {
        labelMap[label] = value;
    });
}

function advanceSection(counters: CounterState, level: SectionLevel): string {
    if (level === 'section') {
        counters.sec++;
        counters.subsec = 0;
        counters.subsubsec = 0;
    } else if (level === 'subsection') {
        counters.subsec++;
        counters.subsubsec = 0;
    } else {
        counters.subsubsec++;
    }
    return formatSectionCounter(counters);
}

function formatSectionCounter(counters: CounterState): string {
    let value = `${counters.sec}`;
    if (counters.subsec > 0) { value += `.${counters.subsec}`; }
    if (counters.subsubsec > 0) { value += `.${counters.subsubsec}`; }
    return value;
}

export function floatKindFromEnvironment(type: string): FloatKind | undefined {
    const normalized = type.replace(/\*$/, '');
    if (normalized === 'figure') { return 'fig'; }
    if (normalized === 'table') { return 'tbl'; }
    if (normalized === 'algorithm') { return 'alg'; }
    return undefined;
}

export function buildScanResultFromSummaries(summaries: readonly BlockScanSummary[]): ScanResult {
    const counters: CounterState = { sec: 0, subsec: 0, subsubsec: 0, eq: 0, fig: 0, tbl: 0, alg: 0 };
    const dynamicCounters: Record<string, number> = {};
    const labelMap: Record<string, string> = {};
    const results: BlockNumbering[] = [];

    summaries.forEach(summary => {
        const blockRes = createEmptyBlockNumbering();

        for (const token of summary.tokens) {
            if (token.kind === 'sec') {
                const numStr = advanceSection(counters, token.level);
                blockRes.counts.sec.push(numStr);
                assignLabels(labelMap, token, numStr);
            } else if (token.kind === 'eq') {
                counters.eq++;
                const numStr = token.tag ?? String(counters.eq);
                blockRes.counts.eq.push(numStr);
                assignLabels(labelMap, token, numStr);
            } else if (token.kind === 'float') {
                counters[token.floatKind]++;
                const numStr = String(counters[token.floatKind]);
                blockRes.counts[token.floatKind].push(numStr);
                assignLabels(labelMap, token, numStr);
            } else {
                dynamicCounters[token.envName] = (dynamicCounters[token.envName] ?? 0) + 1;
                const numStr = String(dynamicCounters[token.envName]);
                blockRes.counts.thm.push(numStr);
                assignLabels(labelMap, token, numStr);
            }
        }

        results.push(blockRes);
    });

    return { blockNumbering: results, labelMap };
}

/**
 * Lightweight SnapTeX numbering scanner.
 *
 * This intentionally models only SnapTeX's preview numbering rules. It does not
 * try to emulate full LaTeX counter expansion, user-defined counter resets, or
 * custom theorem numbering. The scanner caches block-local summaries by hash;
 * unchanged blocks reuse their summaries while final numbers are recomputed from
 * the summaries in document order.
 */
export class LatexCounterScanner implements LatexScanner {
    private summaries: BlockScanSummary[] = [];

    public reset() {
        this.summaries = [];
    }

    public scan(provider: BlockTextProvider): ScanResult {
        const summaries = this.updateSummaries(provider);
        return buildScanResultFromSummaries(summaries);
    }

    private updateSummaries(provider: BlockTextProvider): BlockScanSummary[] {
        const count = provider.getBlockCount();
        const textCache = new Map<number, string>();

        const getText = (index: number) => {
            if (!textCache.has(index)) {
                textCache.set(index, provider.getBlockText(index) ?? '');
            }
            return textCache.get(index) ?? '';
        };

        const hashes = Array.from({ length: count }, (_unused, index) => {
            const hash = provider.getBlockHash(index);
            if (hash !== undefined) { return hash; }

            const text = provider.getBlockText(index) ?? '';
            textCache.set(index, text);
            return stableHash(text);
        });
        const previous = this.summaries;
        const currentHashes = hashes.map(hash => ({ hash }));
        const diff = DiffEngine.compute(previous, currentHashes);
        const next = DiffEngine.rebuildArray(
            previous,
            count,
            diff,
            index => this.parseBlock(getText(index), hashes[index]),
            summary => summary
        );

        this.summaries = next;
        return next;
    }

    private parseBlock(text: string, hash: string): BlockScanSummary {
        const tokens: ScanToken[] = [];

        const secRegex = new RegExp(`\\\\(${REGEX_STR.SECTION_LEVELS})(\\*?)\\s*\\{`, 'g');
        const eqRegex = new RegExp(`\\\\begin\\{(${REGEX_STR.MATH_ENVS})\\}(\\*?)`, 'g');
        const floatRegex = new RegExp(`\\\\begin\\{(${REGEX_STR.FLOAT_ENVS})(\\*)?\\}`, 'g');
        const thmRegex = new RegExp(`\\\\begin\\{(${REGEX_STR.THEOREM_ENVS})\\}`, 'g');

        let match;

        while ((match = secRegex.exec(text)) !== null) {
            if (match[2] === '*') { continue; }
            tokens.push({
                pos: match.index,
                kind: 'sec',
                level: match[1] as SectionLevel,
                label: this.extractLabelNear(text, match.index)
            });
        }

        while ((match = eqRegex.exec(text)) !== null) {
            if (match[2] === '*') { continue; }
            const env = this.extractEnvInfo(text, match.index, match[1]);
            tokens.push({
                pos: match.index,
                kind: 'eq',
                label: env.label,
                tag: env.tag
            });
        }

        while ((match = floatRegex.exec(text)) !== null) {
            const floatKind = floatKindFromEnvironment(match[1]);
            if (!floatKind) { continue; }
            tokens.push({
                pos: match.index,
                kind: 'float',
                floatKind,
                label: this.extractEnvInfo(text, match.index, match[1]).label
            });
        }

        while ((match = thmRegex.exec(text)) !== null) {
            const envName = match[1].toLowerCase();
            tokens.push({
                pos: match.index,
                kind: 'thm',
                envName,
                label: this.extractEnvInfo(text, match.index, match[1]).label
            });
        }

        tokens.sort((a, b) => a.pos - b.pos);
        return { hash, tokens };
    }

    private extractLabelNear(text: string, startIdx: number): string | undefined {
        const sub = text.substring(startIdx, startIdx + 200);
        return extractLatexLabelNames(sub)[0];
    }

    private extractEnvInfo(text: string, startIdx: number, envName: string): { label?: string; tag?: string } {
        const sub = text.substring(startIdx);
        const endRegex = new RegExp(`\\\\end\\{${envName}\\*?\\}`);
        const endMatch = sub.match(endRegex);
        const limit = endMatch ? (endMatch.index! + endMatch[0].length) : sub.length;
        const block = sub.substring(0, limit);
        const label = extractLatexLabelNames(block)[0];
        const tag = block.match(/\\tag\*?\s*\{([^}]+)\}/)?.[1];
        return { label, tag };
    }

}
