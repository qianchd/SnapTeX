export interface TikzPreviewSourceParts {
    globalPreamble: string;
    options: string;
    content: string;
    macroDefinitions: string;
}

export interface TikzPreviewLoweringResult {
    source: TikzPreviewSourceParts;
    changed: boolean;
}

export interface TikzPreviewLowering {
    name: string;
    affectedLibraries: string[];
    description: string;
    apply(source: TikzPreviewSourceParts): TikzPreviewLoweringResult;
}

export interface TikzPreviewOptimizationResult extends TikzPreviewSourceParts {
    appliedLowerings: string[];
}

const SIMPLE_META_ARROW_TIPS = ['Latex', 'Stealth'];

function rewriteSimpleMetaArrowTips(text: string): string {
    if (!text) { return text; }

    const tipPattern = `(?:${SIMPLE_META_ARROW_TIPS.join('|')})`;
    const delimiter = '(?=\\s*(?:[,}\\]]|$))';

    return text
        .replace(new RegExp(`\\b${tipPattern}\\s*-\\s*${tipPattern}\\b${delimiter}`, 'g'), '<->')
        .replace(new RegExp(`-\\s*${tipPattern}\\b${delimiter}`, 'g'), '->')
        .replace(new RegExp(`\\b${tipPattern}\\s*-${delimiter}`, 'g'), '<-');
}

function rewriteSourceParts(
    source: TikzPreviewSourceParts,
    rewrite: (text: string) => string
): TikzPreviewLoweringResult {
    const next: TikzPreviewSourceParts = {
        globalPreamble: rewrite(source.globalPreamble),
        options: rewrite(source.options),
        content: rewrite(source.content),
        macroDefinitions: rewrite(source.macroDefinitions)
    };

    return {
        source: next,
        changed:
            next.globalPreamble !== source.globalPreamble ||
            next.options !== source.options ||
            next.content !== source.content ||
            next.macroDefinitions !== source.macroDefinitions
    };
}

/**
 * Declarative preview-only lowerings for expensive TikZ libraries.
 *
 * Lowerings trade small visual differences for faster TikZJax compilation.
 * Exact or parameterized constructs should pass through unchanged so the
 * corresponding library pruning logic can still keep the required library.
 */
export const TIKZ_PREVIEW_LOWERINGS: TikzPreviewLowering[] = [
    {
        name: 'simple-arrows-meta-tips',
        affectedLibraries: ['arrows.meta'],
        description: 'Lower simple Latex/Stealth arrow tips to core TikZ arrows when no parameterized arrow tip syntax is used.',
        apply: source => rewriteSourceParts(source, rewriteSimpleMetaArrowTips)
    }
];

export function optimizeTikzPreviewSource(
    source: TikzPreviewSourceParts,
    lowerings: TikzPreviewLowering[] = TIKZ_PREVIEW_LOWERINGS
): TikzPreviewOptimizationResult {
    let current = source;
    const appliedLowerings: string[] = [];

    for (const lowering of lowerings) {
        const result = lowering.apply(current);
        current = result.source;
        if (result.changed) {
            appliedLowerings.push(lowering.name);
        }
    }

    return {
        ...current,
        appliedLowerings
    };
}
