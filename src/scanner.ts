import { DiffEngine } from './diff';
import { REGEX_STR } from './patterns';
import { BlockNumberingCounts } from './types';
import { extractLatexLabelNames } from './utils';

export interface ScanResult {
    blockNumbering: BlockNumberingCounts[];
    labelMap: Record<string, string>;
}

export interface BlockScanInput {
    count: number;
    getText(index: number): string;
    hashes: readonly string[];
}

export type SectionLevel = 'section' | 'subsection' | 'subsubsection' | 'paragraph' | 'subparagraph';
export type FloatKind = 'fig' | 'tbl' | 'alg';

export type ScanToken =
    | { pos: number; kind: 'sec'; level: SectionLevel; label?: string }
    | { pos: number; kind: 'eq'; label?: string; labels?: string[]; tag?: string }
    | { pos: number; kind: 'float'; floatKind: FloatKind; label?: string; labels?: string[] }
    | { pos: number; kind: 'subfloat'; label?: string; labels?: string[] }
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
    subfig: number;
    tbl: number;
    alg: number;
}

function createEmptyBlockNumbering(): BlockNumberingCounts {
    return { eq: [], fig: [], subfig: [], tbl: [], alg: [], sec: [], thm: [] };
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

function formatSubfigureCounter(value: number): string {
    let current = value;
    let label = '';
    while (current > 0) {
        current--;
        label = String.fromCharCode(97 + (current % 26)) + label;
        current = Math.floor(current / 26);
    }
    return label || 'a';
}

export function floatKindFromEnvironment(type: string): FloatKind | undefined {
    const normalized = type.replace(/\*$/, '');
    if (normalized === 'figure') { return 'fig'; }
    if (normalized === 'table') { return 'tbl'; }
    if (normalized === 'algorithm') { return 'alg'; }
    return undefined;
}

export function buildScanResultFromSummaries(summaries: readonly BlockScanSummary[]): ScanResult {
    const counters: CounterState = { sec: 0, subsec: 0, subsubsec: 0, eq: 0, fig: 0, subfig: 0, tbl: 0, alg: 0 };
    const dynamicCounters: Record<string, number> = {};
    const labelMap: Record<string, string> = {};
    const results: BlockNumberingCounts[] = [];

    summaries.forEach(summary => {
        const blockRes = createEmptyBlockNumbering();

        for (const token of summary.tokens) {
            if (token.kind === 'sec') {
                const numStr = advanceSection(counters, token.level);
                blockRes.sec.push(numStr);
                assignLabels(labelMap, token, numStr);
            } else if (token.kind === 'eq') {
                counters.eq++;
                const numStr = token.tag ?? String(counters.eq);
                blockRes.eq.push(numStr);
                assignLabels(labelMap, token, numStr);
            } else if (token.kind === 'float') {
                counters[token.floatKind]++;
                if (token.floatKind === 'fig') {
                    counters.subfig = 0;
                }
                const numStr = String(counters[token.floatKind]);
                blockRes[token.floatKind].push(numStr);
                assignLabels(labelMap, token, numStr);
            } else if (token.kind === 'subfloat') {
                counters.subfig++;
                const suffix = formatSubfigureCounter(counters.subfig);
                blockRes.subfig.push(suffix);
                assignLabels(labelMap, token, `${counters.fig}${suffix}`);
            } else {
                dynamicCounters[token.envName] = (dynamicCounters[token.envName] ?? 0) + 1;
                const numStr = String(dynamicCounters[token.envName]);
                blockRes.thm.push(numStr);
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
export class LatexCounterScanner {
    private summaries: BlockScanSummary[] = [];

    public reset() {
        this.summaries = [];
    }

    public scan(input: BlockScanInput): ScanResult {
        const summaries = this.updateSummaries(input);
        return buildScanResultFromSummaries(summaries);
    }

    private updateSummaries({ count, getText, hashes }: BlockScanInput): BlockScanSummary[] {
        const previous = this.summaries;
        const diff = DiffEngine.compute(previous, hashes);
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
        const tokenRegex = new RegExp(
            `\\\\(?:(${REGEX_STR.SECTION_LEVELS})(\\*)?\\s*\\{|begin\\{(?:(${REGEX_STR.MATH_ENVS})(\\*)?|(${REGEX_STR.FLOAT_ENVS})(\\*)?|(${REGEX_STR.THEOREM_ENVS}))\\})`,
            'g'
        );
        let match: RegExpExecArray | null;

        while ((match = tokenRegex.exec(text)) !== null) {
            const [section, sectionStar, mathEnv, mathStar, floatEnv, , theoremEnv] = match.slice(1);
            if (section) {
                if (sectionStar) { continue; }
                tokens.push({
                    pos: match.index,
                    kind: 'sec',
                    level: section as SectionLevel,
                    label: this.extractLabelNear(text, match.index)
                });
            } else if (mathEnv) {
                if (mathStar) { continue; }
                const env = this.extractEnvInfo(text, match.index, mathEnv);
                tokens.push({ pos: match.index, kind: 'eq', label: env.label, tag: env.tag });
            } else if (floatEnv) {
                const floatKind = floatKindFromEnvironment(floatEnv);
                if (!floatKind) { continue; }
                const env = this.extractEnvInfo(text, match.index, floatEnv, floatKind === 'fig');
                tokens.push({ pos: match.index, kind: 'float', floatKind, label: env.label });
                if (floatKind === 'fig') {
                    tokens.push(...this.extractSubfigureTokens(env.block, match.index));
                }
            } else if (theoremEnv) {
                tokens.push({
                    pos: match.index,
                    kind: 'thm',
                    envName: theoremEnv.toLowerCase(),
                    label: this.extractEnvInfo(text, match.index, theoremEnv).label
                });
            }
        }
        tokens.sort((a, b) => a.pos - b.pos);
        return { hash, tokens };
    }

    private extractLabelNear(text: string, startIdx: number): string | undefined {
        const sub = text.substring(startIdx, startIdx + 200);
        return extractLatexLabelNames(sub)[0];
    }

    private extractEnvInfo(text: string, startIdx: number, envName: string, omitSubfigures = false): { label?: string; tag?: string; block: string } {
        const sub = text.substring(startIdx);
        const endRegex = new RegExp(`\\\\end\\{${envName}\\*?\\}`);
        const endMatch = sub.match(endRegex);
        const limit = endMatch ? (endMatch.index! + endMatch[0].length) : sub.length;
        const block = sub.substring(0, limit);
        const labelSource = omitSubfigures ? this.stripSubfigureEnvironments(block) : block;
        const label = extractLatexLabelNames(labelSource)[0];
        const tag = block.match(/\\tag\*?\s*\{([^}]+)\}/)?.[1];
        return { label, tag, block };
    }

    private stripSubfigureEnvironments(text: string): string {
        return text.replace(/\\begin\{subfigure\*?\}(?:\[[^\]]*\])?\s*\{[^{}]*\}[\s\S]*?\\end\{subfigure\*?\}/gi, '');
    }

    private extractSubfigureTokens(block: string, basePos: number): ScanToken[] {
        const tokens: ScanToken[] = [];
        const regex = /\\begin\{subfigure\*?\}(?:\[[^\]]*\])?\s*\{[^{}]*\}[\s\S]*?\\end\{subfigure\*?\}/gi;
        let match;
        while ((match = regex.exec(block)) !== null) {
            tokens.push({
                pos: basePos + match.index,
                kind: 'subfloat',
                label: extractLatexLabelNames(match[0])[0]
            });
        }
        return tokens;
    }

}
