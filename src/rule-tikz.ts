import type { PreambleData, PreprocessRule, RenderContext } from './types';
import { escapeScriptRawText, extractAndHideLabels } from './utils';
import { optimizeTikzPreviewSource } from './tikz-preview-optimizer';

function resolveDependencies(content: string, macroMap: Map<string, string>): string {
    const usedMacros = new Set<string>();
    const queue: string[] = [content];
    const resolvedDefs: string[] = [];
    const tokenRegex = /\\[a-zA-Z@]+/g;

    while (queue.length > 0) {
        const text = queue.pop()!;
        const tokens = text.match(tokenRegex);
        if (!tokens) { continue; }

        for (const token of tokens) {
            if (macroMap.has(token) && !usedMacros.has(token)) {
                usedMacros.add(token);
                const def = macroMap.get(token)!;
                resolvedDefs.push(def);
                queue.push(def);
            }
        }
    }

    return resolvedDefs.join('\n');
}

const TIKZ_LIBRARY_PATTERNS: Record<string, RegExp[]> = {
    calc: [
        /\$\s*\([^]*?\)\s*\$/m,
        /!\s*[-+]?\d*\.?\d+\s*!/,
        /\bintersection of\b/i
    ],
    'shapes.geometric': [
        /\b(?:shape\s*=\s*)?(?:diamond|ellipse|trapezium|semicircle|regular polygon|star|dart|kite|cylinder|isosceles triangle)\b/i
    ],
    positioning: [
        /\b(?:above|below|left|right|above left|above right|below left|below right|base left|base right)\s*=\s*(?:of\b|[^,\]]*\bof\b)/i,
        /\bnode distance\b/i
    ],
    'decorations.pathreplacing': [
        /\bdecorate\b/i,
        /\bdecoration\s*=\s*\{?[^,\]}]*(?:brace|expanding waves|ticks|border|coil|zigzag)/i
    ],
    patterns: [
        /\bpattern\s*=/i,
        /\bpattern color\s*=/i
    ],
    'arrows.meta': [
        /\b(?:Stealth|Latex|Triangle|Circle|Square|Bar|Bracket|Hooks?|Implies|Computer Modern|Classical TikZ)\b/,
        /[-<>]\s*\{[^}]*\}/
    ],
    backgrounds: [
        /\bon background layer\b/i,
        /\\begin\{pgfonlayer\}\{background\}/i,
        /\bbackground rectangle\b/i,
        /\bshow background\b/i
    ],
    angles: [
        /\bpic\s*(?:\[[^\]]*\])?\s*\{(?:right\s+)?angle\s*=/i,
        /\bangle\s*=/i
    ],
    fit: [
        /\bfit\s*=/i
    ],
    matrix: [
        /\\matrix\b/i,
        /\bmatrix of\b/i
    ],
    quotes: [
        /\b(?:edge|node)\s*\[[^\]]*["']/i
    ]
};

function splitTikzLibraries(libraries: string): string[] {
    return libraries
        .split(',')
        .map(library => library.trim())
        .filter(Boolean);
}

function extractUsedTikzStyleDefinitions(globalPreamble: string, pictureSource: string): string {
    const usedDefinitions: string[] = [];
    const visitedStyles = new Set<string>();
    const styleRegex = /([A-Za-z@][\w@./:-]*)\s*\/\.style(?:\s+(?:args|n args))?\s*=\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
    const styleDefinitions = new Map<string, string>();
    let match;

    while ((match = styleRegex.exec(globalPreamble)) !== null) {
        styleDefinitions.set(match[1], match[2]);
    }

    const visitStyle = (styleName: string) => {
        if (visitedStyles.has(styleName)) { return; }

        const definition = styleDefinitions.get(styleName);
        if (!definition) { return; }

        visitedStyles.add(styleName);
        usedDefinitions.push(definition);

        for (const nestedStyle of styleDefinitions.keys()) {
            if (new RegExp(`(^|[^A-Za-z0-9@./:-])${nestedStyle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9@./:-]|$)`).test(definition)) {
                visitStyle(nestedStyle);
            }
        }
    };

    for (const styleName of styleDefinitions.keys()) {
        if (new RegExp(`(^|[^A-Za-z0-9@./:-])${styleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9@./:-]|$)`).test(pictureSource)) {
            visitStyle(styleName);
        }
    }

    return usedDefinitions.join('\n');
}

function shouldIncludeTikzLibrary(library: string, signalText: string): boolean {
    const patterns = TIKZ_LIBRARY_PATTERNS[library];
    if (!patterns) { return true; }
    return patterns.some(pattern => pattern.test(signalText));
}

function filterTikzGlobalForPicture(globalPreamble: string, pictureSource: string): string {
    const libraryRegex = /\\usetikzlibrary\s*\{([^{}]*)\}/g;
    const requestedLibraries: string[] = [];
    const retainedGlobals: string[] = [];
    let lastIndex = 0;
    let match;

    while ((match = libraryRegex.exec(globalPreamble)) !== null) {
        const before = globalPreamble.substring(lastIndex, match.index).trim();
        if (before) { retainedGlobals.push(before); }
        requestedLibraries.push(...splitTikzLibraries(match[1]));
        lastIndex = libraryRegex.lastIndex;
    }

    const after = globalPreamble.substring(lastIndex).trim();
    if (after) { retainedGlobals.push(after); }

    const signalText = `${pictureSource}\n${extractUsedTikzStyleDefinitions(globalPreamble, pictureSource)}`;
    const selectedLibraries = Array.from(new Set(
        requestedLibraries.filter(library => shouldIncludeTikzLibrary(library, signalText))
    ));
    const selectedLibraryPreamble = selectedLibraries.length > 0
        ? [`\\usetikzlibrary{${selectedLibraries.join(', ')}}`]
        : [];

    return [...selectedLibraryPreamble, ...retainedGlobals].join('\n');
}

/**
 * Builds the inert TikZJax container shared by legacy and AST renderers.
 */
export function renderTikzPictureHtml(options: string, content: string, metadata?: PreambleData): { html: string; hiddenHtml: string } {
    const { cleanContent, hiddenHtml } = extractAndHideLabels(content);
    const macroMap = metadata?.tikzMacroMap || new Map();
    const neededMacros = resolveDependencies(`${options}\n${cleanContent}`, macroMap);
    const optimized = optimizeTikzPreviewSource({
        globalPreamble: metadata?.tikzGlobal || "",
        options,
        content: cleanContent,
        macroDefinitions: neededMacros
    });
    const opts = optimized.options ? `[${optimized.options}]` : '';
    const globalPreamble = filterTikzGlobalForPicture(
        optimized.globalPreamble,
        `${opts}\n${optimized.content}\n${optimized.macroDefinitions}`
    );
    const fontConfig = `\\tikzset{every node/.append style={font=\\sffamily\\small}}\n`;

    const fullCode = [
        globalPreamble,
        optimized.macroDefinitions,
        fontConfig,
        `\\begin{tikzpicture}${opts}`,
        optimized.content,
        `\\end{tikzpicture}`
    ].join('\n');

    return {
        html: `<div class="tikz-container">
                    <script type="text/snaptex-tikz" data-show-console="false">
                        ${escapeScriptRawText(fullCode)}
                    </script>
                </div>`,
        hiddenHtml
    };
}

/**
 * Renders tikzpicture environments as inert TikZJax scripts.
 *
 * The rule prunes global TikZ library/style input to the current picture and
 * resolves only macro definitions reachable from the picture source.
 */
export function createTikzPictureRule(): PreprocessRule {
    return {
        name: 'tikzpicture',
        priority: 6,
        apply: (text, renderer: RenderContext) => {
            const regex = /\\begin\{tikzpicture\}(?:\[([\s\S]*?)\])?([\s\S]*?)\\end\{tikzpicture\}/g;

            return text.replace(regex, (_match, options, content) => {
                const rendered = renderTikzPictureHtml(options || '', content, renderer.metadata);
                return renderer.protectHtml('tikz', rendered.html) + (rendered.hiddenHtml ? renderer.protectHtml('raw', rendered.hiddenHtml) : '');
            });
        }
    };
}
