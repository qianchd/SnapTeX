import { REGEX_STR } from '../patterns';
import {
    buildScanResultFromSummaries,
    floatKindFromEnvironment,
    type BlockScanSummary,
    type BlockTextProvider,
    type ScanResult,
    type ScanToken,
    type SectionLevel
} from '../scanner';
import { stableHash } from '../utils';
import { parseLatexToAst } from './parse';
import { DiffEngine } from '../diff';
import {
    argumentText,
    collectMacroArgumentTexts,
    environmentName,
    findMacroArgumentText,
    getSourcePosition,
    isEnvironmentNode,
    isMacroNode,
    readRequiredMacroArgument,
    visitLatexAst
} from './visit-utils';
import type { SnaptexAstNode } from './types';
import type { AstParseResult } from './types';

/**
 * AST-based numbering scanner.
 *
 * This implementation passes the current scanner tests and can produce more
 * structured summaries than the regex scanner, especially around comments,
 * verbatim-like content, and multiple labels inside one numbered object.
 * It is intentionally not wired into the production render path yet: parsing
 * every block for numbering is much heavier than the legacy scanner, and
 * numbering must be committed in document order rather than as individual
 * AST artifacts finish warming. Keep this module available for validation and
 * future background correction work.
 */
const SECTION_LEVELS = new Set(REGEX_STR.SECTION_LEVELS.split('|') as SectionLevel[]);
const MATH_ENVIRONMENTS = new Set(REGEX_STR.MATH_ENVS.split('|'));
const THEOREM_ENVIRONMENTS = new Set(REGEX_STR.THEOREM_ENVS.split('|'));

interface PositionedLabel {
    pos: number;
    label: string;
}

function nodePosition(node: unknown): number {
    return getSourcePosition(node)?.start.offset ?? 0;
}

function normalizedEnvironmentName(envName: string): string {
    return envName.toLowerCase().replace(/\*$/, '');
}

function isStarredSection(node: SnaptexAstNode): boolean {
    return isMacroNode(node) && argumentText(node.args?.[0]).trim() === '*';
}

function attachNearbySectionLabels(tokens: ScanToken[], labels: readonly PositionedLabel[]): ScanToken[] {
    return tokens.map(token => {
        if (token.kind !== 'sec' || token.label) {
            return token;
        }
        const label = labels.find(candidate => candidate.pos >= token.pos && candidate.pos - token.pos <= 200)?.label;
        return label ? { ...token, label } : token;
    });
}

export class AstLatexScanner {
    private summaries: BlockScanSummary[] = [];

    constructor(private readonly parse: (text: string) => Promise<AstParseResult> = parseLatexToAst) {}

    reset() {
        this.summaries = [];
    }

    async scan(provider: BlockTextProvider): Promise<ScanResult> {
        const summaries = await this.updateSummaries(provider);
        return buildScanResultFromSummaries(summaries);
    }

    private async updateSummaries(provider: BlockTextProvider): Promise<BlockScanSummary[]> {
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

            const text = getText(index);
            return stableHash(text);
        });
        const diff = DiffEngine.compute(this.summaries, hashes.map(hash => ({ hash })));
        const next = await DiffEngine.rebuildArrayAsync(
            this.summaries,
            count,
            diff,
            index => this.parseBlock(getText(index), hashes[index]),
            summary => summary
        );
        this.summaries = next;
        return next;
    }

    private async parseBlock(text: string, hash: string): Promise<BlockScanSummary> {
        const result = await this.parse(text);
        if (!result.ast || result.errors.length > 0) {
            return { hash, tokens: [] };
        }

        const tokens: ScanToken[] = [];
        const labels: PositionedLabel[] = [];

        visitLatexAst(result.ast, node => {
            if (isMacroNode(node, 'label')) {
                labels.push({
                    pos: nodePosition(node),
                    label: argumentText(readRequiredMacroArgument(node))
                });
                return;
            }

            if (isMacroNode(node) && SECTION_LEVELS.has(node.content as SectionLevel) && !isStarredSection(node)) {
                tokens.push({
                    pos: nodePosition(node),
                    kind: 'sec',
                    level: node.content as SectionLevel
                });
                return;
            }

            if (isEnvironmentNode(node)) {
                const rawEnvName = environmentName(node);
                if (!rawEnvName) {
                    return;
                }

                const envName = normalizedEnvironmentName(rawEnvName);
                const content = Array.isArray(node.content) ? node.content : [];
                const labelsInEnvironment = collectEnvironmentLabels(content);

                if (MATH_ENVIRONMENTS.has(envName) && !rawEnvName.endsWith('*')) {
                    tokens.push({
                        pos: nodePosition(node),
                        kind: 'eq',
                        labels: labelsInEnvironment,
                        tag: findMacroArgumentText(content, 'tag')
                    });
                    return;
                }

                const floatKind = floatKindFromEnvironment(rawEnvName);
                if (floatKind) {
                    tokens.push({
                        pos: nodePosition(node),
                        kind: 'float',
                        floatKind,
                        labels: labelsInEnvironment
                    });
                    return;
                }

                if (THEOREM_ENVIRONMENTS.has(envName)) {
                    tokens.push({
                        pos: nodePosition(node),
                        kind: 'thm',
                        envName,
                        labels: labelsInEnvironment
                    });
                }
            }
        });

        tokens.sort((a, b) => a.pos - b.pos);
        return {
            hash,
            tokens: attachNearbySectionLabels(tokens, labels)
        };
    }
}

function collectEnvironmentLabels(content: readonly SnaptexAstNode[]): string[] {
    return collectMacroArgumentTexts(content, 'label').filter(Boolean);
}
