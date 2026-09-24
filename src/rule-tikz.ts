import type { PreprocessRule, RenderContext } from './types';
import { CITATION_COMMANDS } from './patterns';
import { renderCitationTex, renderNumberedEquationHtml } from './rule-helpers';
import { escapeRegExp, escapeScriptRawText, extractAndHideLabels, replaceLatexCommandCalls, splitLatexCitationKeys, stripLatexComments } from './utils';
import { optimizeTikzPreviewSource } from './tikz-preview-optimizer';

type TikzEnvironmentName = 'tikzpicture' | 'tikzcd';

function parseTikzEnvironmentSource(source: string): { environment: TikzEnvironmentName; options: string; content: string } | undefined {
    const match = /^\\begin\{(tikzpicture|tikzcd)\}(?:\[([^\]]*)\])?([\s\S]*)\\end\{\1\}$/.exec(source.trim());
    return match
        ? { environment: match[1] as TikzEnvironmentName, options: match[2] ?? '', content: match[3] }
        : undefined;
}

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
            if (new RegExp(`(^|[^A-Za-z0-9@./:-])${escapeRegExp(nestedStyle)}([^A-Za-z0-9@./:-]|$)`).test(definition)) {
                visitStyle(nestedStyle);
            }
        }
    };

    for (const styleName of styleDefinitions.keys()) {
        if (new RegExp(`(^|[^A-Za-z0-9@./:-])${escapeRegExp(styleName)}([^A-Za-z0-9@./:-]|$)`).test(pictureSource)) {
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
function renderTikzEnvironmentHtml(
    environment: TikzEnvironmentName,
    options: string,
    content: string,
    renderer: Pick<RenderContext, 'metadata' | 'bibEntries' | 'resolveCitation'>
): { html: string; hiddenHtml: string } {
    const { cleanContent, hiddenHtml } = extractAndHideLabels(content);
    const resolvedContent = replaceLatexCommandCalls(cleanContent, {
        name: CITATION_COMMANDS,
        optionalArgs: 2,
        requiredArgs: 1,
        allowStar: true,
        render: call => renderCitationTex(call.name, splitLatexCitationKeys(call.requiredArgs[0].content), {
            pre: call.optionalArgs.length > 1 ? call.optionalArgs[0].content : undefined,
            post: call.optionalArgs[call.optionalArgs.length - 1]?.content
        }, renderer)
    });
    const metadata = renderer.metadata;
    const macroMap = metadata?.tikzMacroMap || new Map();
    const neededMacros = resolveDependencies(`${options}\n${resolvedContent}`, macroMap);
    const optimized = optimizeTikzPreviewSource({
        globalPreamble: metadata?.tikzGlobal || "",
        options,
        content: resolvedContent,
        macroDefinitions: neededMacros
    });
    const opts = optimized.options ? `[${optimized.options}]` : '';
    const globalPreamble = filterTikzGlobalForPicture(
        optimized.globalPreamble,
        `${opts}\n${optimized.content}\n${optimized.macroDefinitions}`
    );
    const fontConfig = `\\tikzset{every node/.append style={font=\\sffamily\\small}}\n`;

    const fullCode = [
        '\\makeatletter',
        globalPreamble,
        optimized.macroDefinitions,
        '\\makeatother',
        fontConfig,
        `\\begin{${environment}}${opts}`,
        optimized.content,
        `\\end{${environment}}`
    ].join('\n');
    const packages = {
        ...(/\\boldsymbol\b/.test(fullCode) ? { amsbsy: '' } : {}),
        ...(environment === 'tikzcd' ? { 'tikz-cd': '' } : {})
    };
    const packageAttribute = Object.keys(packages).length > 0
        ? ` data-tex-packages='${JSON.stringify(packages)}'`
        : '';

    return {
        html: `<div class="tikz-container">
                    <script type="text/snaptex-tikz" data-show-console="false"${packageAttribute}>
                        ${escapeScriptRawText(fullCode)}
                    </script>
                </div>`,
        hiddenHtml
    };
}

export function renderTikzSourceHtml(
    source: string,
    renderer: Pick<RenderContext, 'metadata' | 'bibEntries' | 'resolveCitation'>
): string | undefined {
    source = stripLatexComments(source).trim();
    const equation = /^\\begin\{equation(\*)?\}([\s\S]*)\\end\{equation\1\}$/.exec(source);
    let hiddenHtml = '';
    if (equation) {
        const extracted = extractAndHideLabels(equation[2]);
        source = extracted.cleanContent.trim();
        hiddenHtml = extracted.hiddenHtml;
    }

    const parsed = parseTikzEnvironmentSource(source);
    if (!parsed) { return undefined; }

    const rendered = renderTikzEnvironmentHtml(parsed.environment, parsed.options, parsed.content, renderer);
    hiddenHtml += rendered.hiddenHtml;
    return equation && !equation[1]
        ? renderNumberedEquationHtml(rendered.html, '(<span class="sn-cnt" data-type="eq"></span>)', hiddenHtml)
        : rendered.html + hiddenHtml;
}

/**
 * Renders supported TikZ environments as inert TikZJax scripts.
 *
 * The rule prunes global TikZ library/style input to the current picture and
 * resolves only macro definitions reachable from the picture source.
 */
export function createTikzRule(): PreprocessRule {
    return {
        priority: 6,
        apply: (text, renderer: RenderContext) => {
            text = text.replace(/\\begin\{(equation\*?)\}[\s\S]*?\\begin\{tikzcd\}[\s\S]*?\\end\{tikzcd\}[\s\S]*?\\end\{\1\}/g, match => {
                const html = renderTikzSourceHtml(match, renderer);
                return html ? renderer.protectHtml('tikz', html) : match;
            });
            return text.replace(/\\begin\{(tikzpicture|tikzcd)\}(?:\[[\s\S]*?\])?[\s\S]*?\\end\{\1\}/g, match => {
                const html = renderTikzSourceHtml(match, renderer);
                return html ? renderer.protectHtml('tikz', html) : match;
            });
        }
    };
}
