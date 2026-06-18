interface TikzPreviewSourceParts {
    globalPreamble: string;
    options: string;
    content: string;
    macroDefinitions: string;
}

const SIMPLE_META_ARROW_TIPS = ['Latex', 'Stealth'];

function rewriteSimpleMetaArrowTips(text: string): string {
    const tipPattern = `(?:${SIMPLE_META_ARROW_TIPS.join('|')})`;
    const delimiter = '(?=\\s*(?:[,}\\]]|$))';

    return text
        .replace(new RegExp(`\\b${tipPattern}\\s*-\\s*${tipPattern}\\b${delimiter}`, 'g'), '<->')
        .replace(new RegExp(`-\\s*${tipPattern}\\b${delimiter}`, 'g'), '->')
        .replace(new RegExp(`\\b${tipPattern}\\s*-${delimiter}`, 'g'), '<-');
}

/**
 * Applies preview-only source simplifications for expensive TikZ libraries.
 *
 * These rewrites trade small visual differences for faster TikZJax compilation.
 * Exact or parameterized constructs should pass through unchanged so the
 * corresponding library pruning logic can still keep the required library.
 */
export function optimizeTikzPreviewSource(source: TikzPreviewSourceParts): TikzPreviewSourceParts {
    return {
        globalPreamble: rewriteSimpleMetaArrowTips(source.globalPreamble),
        options: rewriteSimpleMetaArrowTips(source.options),
        content: rewriteSimpleMetaArrowTips(source.content),
        macroDefinitions: rewriteSimpleMetaArrowTips(source.macroDefinitions)
    };
}
