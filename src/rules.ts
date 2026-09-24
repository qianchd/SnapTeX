import {
    BUILTIN_METADATA_EXTRACTOR,
    readMetadataCommand,
    stripLatexDefinitions
} from './metadata';
import {
    createHiddenLabelAnchor,
    expandLatexTextMacros,
    escapeHtml,
    escapeRegExp,
    extractAndHideLabels,
    formatEnumerateLabel,
    normalizeEnumerateLabelTemplate,
    splitLatexCitationKeys,
    replaceLatexCommandCalls,
    replaceLegacyRomanNumerals,
    resolveLatexStyles,
    resolveLatexTextTransforms,
    stripLatexComments
} from './utils';
import { BibEntry, BlockDependencyRule, LatexMacroDefinition, MetadataExtractor, PreambleEnvironmentDefinition, PreprocessRule, RenderContext, SplitterConfig, SplitterRule } from './types';
import { BibTexParser } from './bib';
import {
    REGEX_STR,
    R_ADDBIBRESOURCE,
    R_REF,
    R_CITATION,
    R_BIBLIOGRAPHY,
    R_BIBLIOGRAPHY_STYLE,
    R_PRINTBIBLIOGRAPHY,
    R_THEBIBLIOGRAPHY,
    LATEX_CONTENT_WRAPPER_COMMANDS,
    LATEX_DECLARATION_STYLE_COMMANDS,
    LATEX_DIMENSION_SOURCE,
    LATEX_INLINE_NOTE_COMMANDS,
    LATEX_LAYOUT_BREAK_COMMANDS,
    LATEX_LAYOUT_SWITCH_COMMANDS,
    LATEX_UNBRACED_SPACING_COMMANDS,
    SECTION_LEVELS,
    TRANSPARENT_CONTAINER_ENVIRONMENTS,
    getListTagName,
    getTheoremDisplayName
} from './patterns';
import { createRefLink, createStyleHtmlProtector, latexRelativeWidthPercent, normalizeLatexKeywordSeparators, normalizeMathEnvironmentForKatex, normalizeOptimizationEnvironmentForKatex, renderBibliographyItemsHtml, renderCitationHtml, renderCitedBibliographyHtml, renderInlineLatexHtml, renderInlineNoteHtml, renderMaketitleAuthorsHtml, renderMath, renderNumberedEquationHtml, renderReferenceLinksHtml, renderTheoremHeaderHtml, replaceLatexInlineNotes, replaceLatexLinks, replaceSiunitxCommands, stripLatexPreviewCommands, unwrapLatexContentCommands } from './rule-helpers';
import { createTikzRule } from './rule-tikz';
import { createAlgorithmRule, createFigureRule, createTableRule } from './rule-floats';
import { DEFAULT_AST_RENDER_RULES } from './ast/rules/defaults';
import { DEFAULT_AST_MATH_RULES } from './ast/rules/math';
import type { AstMathRule, AstRenderRule } from './ast/rules';
export { readAstCommandArguments } from './ast/rules';
export type { AstMathRule, AstMathRuleInput, AstMathRuleResult, AstNodeLocation, AstRenderContext, AstRenderInput, AstRenderResult, AstRenderRule } from './ast/rules';

export interface RuleRegistry {
    readonly metadataExtractors: readonly MetadataExtractor[];
    readonly renderRules: readonly PreprocessRule[];
    readonly astRenderRules: readonly AstRenderRule[];
    readonly astMathRules: readonly AstMathRule[];
    readonly blockDependencyRules: readonly BlockDependencyRule[];
    readonly splitterConfig: SplitterConfig;
    readonly splitterRules: readonly SplitterRule[];
}

function replaceLatexLinkCommands(text: string, renderer: RenderContext): string {
    return replaceLatexLinks(text, content => {
        return escapeHtml(resolveLatexStyles(content, createStyleHtmlProtector(renderer), renderer.metadata?.colors));
    }, html => renderer.protectHtml('link', html));
}

const SEMANTIC_MACROS = new Set<string>(
    [...SECTION_LEVELS, ...Object.keys(LATEX_CONTENT_WRAPPER_COMMANDS)].map(name => `\\${name}`)
);

function replaceMathRefs(content: string, renderer: RenderContext): string {
    return content.replace(R_REF, (_match, reftype, key) => {
        return createRefLink(key, renderer, reftype === 'eqref' ? 'eqref' : 'ref');
    });
}

/**
 * Ordered LaTeX-to-Markdown preprocessing pipeline.
 *
 * Rules consume small LaTeX constructs before Markdown-it runs. Any generated
 * HTML must go through RenderContext.protectHtml so Markdown-it cannot escape
 * or expose it as user-visible text.
 */
export function defineBlockDependencyRule(rule: BlockDependencyRule): BlockDependencyRule {
    return rule;
}

export function defineAstRenderRule(rule: AstRenderRule): AstRenderRule {
    return rule;
}

export function defineAstMathRule(rule: AstMathRule): AstMathRule {
    return rule;
}

export function defineRuleRegistry(registry: RuleRegistry): RuleRegistry {
    return {
        metadataExtractors: [...registry.metadataExtractors],
        renderRules: [...registry.renderRules].sort((a, b) => a.priority - b.priority),
        astRenderRules: [...registry.astRenderRules],
        astMathRules: [...registry.astMathRules],
        blockDependencyRules: [...registry.blockDependencyRules],
        splitterConfig: { ...registry.splitterConfig },
        splitterRules: [...registry.splitterRules]
    };
}

const envPattern = (fragment: string, allowStar = false) => new RegExp(`^(${fragment})${allowStar ? '\\*?' : ''}$`);
const layoutBreakPattern = new RegExp(`\\\\(?:${LATEX_LAYOUT_BREAK_COMMANDS.join('|')})\\b(?:\\s*\\[[^\\]]*\\])?(?:\\s*\\{\\s*\\})?\\s*`, 'g');
const layoutSwitchPattern = new RegExp(`\\\\(?:${LATEX_LAYOUT_SWITCH_COMMANDS.join('|')})\\b(?:\\s*\\[[^\\]]*\\])?\\s*`, 'g');
const transparentContainerPattern = new RegExp(`\\\\(?:begin|end)\\{(?:${TRANSPARENT_CONTAINER_ENVIRONMENTS.join('|')})\\}\\s*`, 'gi');
const unbracedSpacingPattern = new RegExp(
    `\\\\(${LATEX_UNBRACED_SPACING_COMMANDS.join('|')})\\b[ \\t]*${LATEX_DIMENSION_SOURCE}[ \\t]*`,
    'gi'
);
const structuralMacroPattern = /\\begin\s*\{(?!picture\s*\})/i;

function stripLatexLayout(text: string, renderer: RenderContext): string {
    text = text.replace(unbracedSpacingPattern, (_match, command: string) => command.toLowerCase() === 'vskip' ? '\n\n' : ' ');
    text = text.replace(/\\(baselineskip|parskip|parindent)\s*=?\s*[-+]?\d+(?:\.\d+)?\s*[a-zA-Z]{2}\s*/g, '');
    text = text.replace(/\\appendix\b\s*/g, '');
    text = text.replace(layoutBreakPattern, '\n\n').replace(layoutSwitchPattern, ' ');
    text = stripLatexPreviewCommands(text);
    text = text.replace(transparentContainerPattern, '');
    return text.replace(/\\noindent\s*/g, () => renderer.protectHtml('raw', '<span class="no-indent-marker"></span>'));
}

function expandDefinedEnvironments(text: string, definitions: Readonly<Record<string, PreambleEnvironmentDefinition>>): string {
    for (let pass = 0; pass < 8; pass++) {
        let changed = false;
        for (const [name, definition] of Object.entries(definitions)) {
            const escapedName = escapeRegExp(name);
            const beginPattern = new RegExp(`\\\\begin\\s*\\{${escapedName}\\}`, 'g');
            const endPattern = new RegExp(`\\\\end\\s*\\{${escapedName}\\}`, 'g');
            let next = text;
            if (definition.kind === 'transparent') {
                next = text.replace(beginPattern, '').replace(endPattern, '');
            } else if (definition.kind === 'style') {
                next = text.replace(beginPattern, `{${definition.declaration} `).replace(endPattern, '}');
            } else if (definition.kind === 'alias') {
                const opening = definition.opening
                    ?? `\\begin{${definition.target}}${definition.options ? `[${definition.options}]` : ''}`;
                next = text
                    .replace(beginPattern, () => opening)
                    .replace(endPattern, () => definition.closing ?? `\\end{${definition.target}}`);
            }
            changed ||= next !== text;
            text = next;
        }
        if (!changed) { break; }
    }
    return text;
}

function expandStructuralMacros(text: string, macros: Readonly<Record<string, LatexMacroDefinition>>): string {
    const structural = Object.fromEntries((text.match(/\\[a-zA-Z0-9@]+/g) ?? [])
        .map(name => [name, macros[name]] as const)
        .filter((entry): entry is readonly [string, LatexMacroDefinition] =>
            entry[1] !== undefined && structuralMacroPattern.test(entry[1].body)
        ));
    return expandLatexTextMacros(text, structural);
}

function replaceInlineMath(text: string, render: (content: string) => string): string {
    let result = '';
    let cursor = 0;
    let start = 0;

    while (start < text.length) {
        if (text[start] === '\\') {
            start += 2;
            continue;
        }
        if (text[start] !== '$'
            || text[start + 1] === '$'
            || text[start - 1] === '$'
            || (text[start - 1] === '{' && text[start + 1] === '}')) {
            start++;
            continue;
        }

        let depth = 0;
        let end = start + 1;
        for (; end < text.length; end++) {
            if (text[end] === '\\') {
                end++;
            } else if (text[end] === '{') {
                depth++;
            } else if (text[end] === '}') {
                depth = Math.max(0, depth - 1);
            } else if (text[end] === '$' && depth === 0) {
                break;
            }
        }
        if (end >= text.length) { break; }

        result += text.slice(cursor, start) + render(text.slice(start + 1, end));
        cursor = end + 1;
        start = cursor;
    }
    return result + text.slice(cursor);
}

// User-facing splitter settings. Long protected constructs get a larger window
// before the splitter treats them as malformed and resumes emergency splitting.
export const DEFAULT_SPLITTER_CONFIG: SplitterConfig = {
    maxBlockLines: 40,
    maxNoEmergencySplitLines: 400
};

export const DEFAULT_SPLITTER_RULES: SplitterRule[] = [
    { name: 'transparent-containers', kind: 'context-wrapper', envPattern: envPattern(TRANSPARENT_CONTAINER_ENVIRONMENTS.join('|')) },
    { name: 'proof-containers', kind: 'context-wrapper', envPattern: envPattern(REGEX_STR.PROOF_ENVS), preserveWrapper: true },
    { name: 'split-math-environments', kind: 'split-env', envPattern: envPattern(REGEX_STR.MATH_ENVS, true), allowNestedBlocks: false },
    { name: 'split-environments', kind: 'split-env', envPattern: envPattern(`${REGEX_STR.FLOAT_ENVS}|${REGEX_STR.THEOREM_ENVS}|${REGEX_STR.ACKNOWLEDGMENT_ENVS}|${REGEX_STR.QUOTE_ENVS}|restatable|thebibliography|tikzpicture`, true) },
    { name: 'protected-math-environments', kind: 'no-emergency-split-env', envPattern: envPattern(REGEX_STR.MATH_ENVS, true) },
    { name: 'protected-environments', kind: 'no-emergency-split-env', envPattern: envPattern(`${REGEX_STR.FLOAT_ENVS}|${REGEX_STR.LIST_ENVS}|${REGEX_STR.ACKNOWLEDGMENT_ENVS}|${REGEX_STR.QUOTE_ENVS}|center|comment|minipage|restatable|thebibliography|tikzpicture|tikzcd`, true) },
    {
        name: 'declaration-style-groups',
        kind: 'context-wrapper',
        macroPattern: new RegExp(`^(?:color|${LATEX_DECLARATION_STYLE_COMMANDS.join('|')})$`),
        content: 'group-remainder'
    },
    {
        name: 'inline-notes',
        kind: 'context-wrapper',
        macroPattern: new RegExp(`^(?:${LATEX_INLINE_NOTE_COMMANDS.join('|')})$`),
        content: { requiredArgument: 0 }
    },
    { name: 'resizebox', kind: 'context-wrapper', macroPattern: /^resizebox$/, content: { requiredArgument: 2 } },
    { name: 'emergency-split-math-end', kind: 'emergency-split-end-env', envPattern: envPattern(REGEX_STR.MATH_ENVS, true) }
];

/**
 * Complete custom metadata example.
 *
 * It stores \editor{...} as metadata.custom.editor. The default \maketitle
 * rule reads this custom field and refreshes when it changes.
 */
export const EDITOR_METADATA_EXTRACTOR = (source: string) => {
    const editor = readMetadataCommand(source, 'editor');
    return editor
        ? { custom: { editor: editor.content }, ranges: [editor.range] }
        : {};
};

function abstractSentinel(content: string): string {
    const trimmed = content.trim();
    return trimmed ? `\n\nOOABSTRACT_STARTOO\n\n${trimmed}\n\nOOABSTRACT_ENDOO\n\n` : '';
}

function keywordsSentinel(content: string): string {
    const trimmed = normalizeLatexKeywordSeparators(content).trim();
    return trimmed ? `\n\nOOKEYWORDS_STARTOO${trimmed}OOKEYWORDS_ENDOO\n\n` : '';
}

const ENUMERATE_LABEL_MARKER = 'SNAP_ENUM_LABEL:';

function encodeEnumerateLabel(label: string): string {
    return `${ENUMERATE_LABEL_MARKER}${encodeURIComponent(label)}`;
}

function decodeEnumerateLabel(label: string): string {
    return label.startsWith(ENUMERATE_LABEL_MARKER)
        ? decodeURIComponent(label.slice(ENUMERATE_LABEL_MARKER.length))
        : label;
}

function renderListLabel(label: string, renderer: RenderContext): string {
    const withMath = label.replace(/\$((?:\\.|[^\\$])*)\$/g, (_match, content) => renderMath(content, false, renderer));
    return escapeHtml(resolveLatexStyles(withMath, createStyleHtmlProtector(renderer), renderer.metadata?.colors));
}

function renderInlineContent(content: string | undefined, renderer: RenderContext): string {
    return renderInlineLatexHtml(
        content,
        tex => renderMath(tex, false, renderer),
        renderer.metadata?.colors
    );
}

function renderLatexListContent(content: string, renderer: RenderContext): string {
    const nestedLists = renderLatexLists(content, renderer);
    const styled = resolveLatexStyles(nestedLists, createStyleHtmlProtector(renderer), renderer.metadata?.colors);
    return renderer.renderInline(styled.trim());
}

function renderLatexLists(text: string, renderer: RenderContext): string {
    const beginRegex = new RegExp(`\\\\begin\\{(${REGEX_STR.LIST_ENVS})\\}\\s*(?:\\[([^\\]]*)\\])?`, 'g');
    let result = "";
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = beginRegex.exec(text)) !== null) {
        const end = findListEnvironmentEnd(text, beginRegex.lastIndex);
        if (!end) {
            continue;
        }

        result += text.slice(cursor, match.index);
        result += renderer.protectHtml('list', renderLatexListHtml(
            getListTagName(match[1])!,
            match[2] ? decodeEnumerateLabel(match[2]) : undefined,
            text.slice(beginRegex.lastIndex, end.contentEnd),
            renderer
        ));
        cursor = end.end;
        beginRegex.lastIndex = cursor;
    }

    return result + text.slice(cursor);
}

function findListEnvironmentEnd(text: string, start: number): { contentEnd: number; end: number } | undefined {
    const tokenRegex = new RegExp(`\\\\(begin|end)\\{(${REGEX_STR.LIST_ENVS})\\}`, 'g');
    tokenRegex.lastIndex = start;
    let depth = 1;
    let match: RegExpExecArray | null;

    while ((match = tokenRegex.exec(text)) !== null) {
        depth += match[1] === 'begin' ? 1 : -1;
        if (depth === 0) {
            return { contentEnd: match.index, end: tokenRegex.lastIndex };
        }
    }

    return undefined;
}

function renderLatexListHtml(
    tagName: 'ul' | 'ol',
    labelTemplate: string | undefined,
    content: string,
    renderer: RenderContext
): string {
    const items = splitLatexListItems(content);
    if (items.length === 0) {
        return '';
    }

    const itemHtml = items.map((item, index) => {
        const rawLabel = item.label ?? (labelTemplate ? formatEnumerateLabel(labelTemplate, index + 1) : '');
        const labelHtml = rawLabel ? `<span class="latex-list-label">${renderListLabel(rawLabel, renderer)}</span> ` : '';
        return `<li>${labelHtml}${renderLatexListContent(item.content, renderer)}</li>`;
    }).join('');
    const className = labelTemplate || items.some(item => item.label) ? 'latex-list latex-list-custom-label' : 'latex-list';

    return `<${tagName} class="${className}">${itemHtml}</${tagName}>`;
}

function splitLatexListItems(content: string): Array<{ label?: string; content: string }> {
    const items: Array<{ label?: string; content: string }> = [];
    const tokenRegex = new RegExp(`\\\\begin\\{(?:${REGEX_STR.LIST_ENVS})\\}|\\\\end\\{(?:${REGEX_STR.LIST_ENVS})\\}|\\\\item(?:\\s*\\[([^\\]]*)\\])?`, 'g');
    let depth = 0;
    let current: { label?: string; start: number } | undefined;
    let match: RegExpExecArray | null;

    while ((match = tokenRegex.exec(content)) !== null) {
        if (match[0].startsWith('\\begin')) {
            depth++;
            continue;
        }
        if (match[0].startsWith('\\end')) {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth > 0) {
            continue;
        }
        if (current) {
            items.push({ label: current.label, content: content.slice(current.start, match.index) });
        }
        current = { label: match[1] ? decodeEnumerateLabel(match[1]) : undefined, start: tokenRegex.lastIndex };
    }

    if (current) {
        items.push({ label: current.label, content: content.slice(current.start) });
    }
    return items;
}

export const DEFAULT_RENDER_RULES: PreprocessRule[] = [
    {
        priority: 5,
        apply: text => stripLatexComments(text).replace(/\\begin\{comment\}[\s\S]*?\\end\{comment\}/gi, '')
    },

    createTikzRule(),

    {
        priority: 6,
        apply: (text, renderer: RenderContext) => expandDefinedEnvironments(text, renderer.metadata?.environments ?? {})
    },
    {
        priority: 7,
        apply: (text, renderer: RenderContext) => expandStructuralMacros(text, renderer.metadata?.macros ?? {})
    },

    {
        priority: 10,
        apply: (text, renderer: RenderContext) => {
            return text.replace(/\\([$])/g, () => renderer.protectHtml('raw', '&#36;'));
        }
    },

    {
        priority: 15,
        apply: stripLatexLayout
    },

    {
        priority: 16,
        apply: (text, renderer: RenderContext) => {
            text = text
                .replace(/\\begin\s*\{center\}/gi, () => `\n\n${renderer.protectHtml('center-open', '<div class="latex-center">')}\n\n`)
                .replace(/\\end\s*\{center\}/gi, () => `\n\n${renderer.protectHtml('center-close', '</div>')}\n\n`);
            return text
                .replace(/\\begin\s*\{minipage\}(?:\s*\[[^\]]*\])*\s*\{([^{}]+)\}/gi, (_match, widthSpec) => {
                    const width = latexRelativeWidthPercent(widthSpec) ?? 100;
                    return `\n\n${renderer.protectHtml('minipage-open', `<div class="latex-minipage" style="width:${width}%">`)}\n\n`;
                })
                .replace(/\\end\s*\{minipage\}/gi, () => `\n\n${renderer.protectHtml('minipage-close', '</div>')}\n\n`);
        }
    },

    {
        priority: 30,
        apply: replaceLegacyRomanNumerals
    },

    {
        priority: 39,
        apply: text => text.replace(
            /\\begin\{((?:mini|maxi)(?:e|!)?)(\*?)\}([\s\S]*?)\\end\{\1\2\}/gi,
            (match, envName: string, star: string, content: string) => {
                const normalized = normalizeOptimizationEnvironmentForKatex(content, envName);
                return normalized === undefined
                    ? match
                    : `\\begin{equation${star}}${normalized}\\end{equation${star}}`;
            }
        )
    },

    {
        priority: 40,
        apply: (text, renderer: RenderContext) => {
            const mathBlockRegex = new RegExp(
                `(\\$\\$([\\s\\S]*?)\\$\\$)|(\\\\\\[([\\s\\S]*?)\\\\\\])|(\\\\begin\\{(${REGEX_STR.MATH_ENVS})(\\*?)\\}([\\s\\S]*?)\\\\end\\{\\6\\7\\})`,
                'gi'
            );

            return text.replace(mathBlockRegex, (match, _m1, c1, _m3, c4, _m5, envName, star, c8, offset, fullString) => {
                if (offset > 0 && fullString[offset - 1] === '\\') { return match; }

                let content = c1 || c4 || c8 || match;

                let eqNumHTML = "";
                if (envName && star !== '*') {
                    eqNumHTML = `(<span class="sn-cnt" data-type="eq"></span>)`;
                }

                const { cleanContent, hiddenHtml } = extractAndHideLabels(content);
                let finalMath = cleanContent.trim();

                finalMath = replaceMathRefs(finalMath, renderer);

                finalMath = normalizeMathEnvironmentForKatex(finalMath, envName);

                const protectedTag = renderMath(finalMath, true, renderer);

                const afterMatch = fullString.substring(offset + match.length);
                const isFollowedByText = /^\s*\S/.test(afterMatch) && !/^\s*\n\n/.test(afterMatch);

                const hiddenLabels = hiddenHtml ? renderer.protectHtml('raw', hiddenHtml) : '';
                let result = protectedTag + hiddenLabels;
                if (eqNumHTML) {
                    result = renderer.protectHtml('math-block', renderNumberedEquationHtml(protectedTag, eqNumHTML, hiddenLabels));
                }
                return result + (isFollowedByText ? renderer.protectHtml('raw', '<span class="no-indent-marker"></span>') : '');
            });
        }
    },

    {
        priority: 45,
        apply: text => text.replace(/\\begin\{(enumerate|compactenum)\}\s*\[([^\]]*)\]/g, (_match, envName, label) => {
            return `\\begin{${envName}}[${encodeEnumerateLabel(normalizeEnumerateLabelTemplate(label))}]`;
        })
    },

    {
        priority: 50,
        apply: (text, renderer: RenderContext) => {
            const processInline = (content: string) => {
                const { cleanContent, hiddenHtml } = extractAndHideLabels(content);
                return renderMath(replaceMathRefs(cleanContent, renderer), false, renderer)
                    + (hiddenHtml ? renderer.protectHtml('raw', hiddenHtml) : '');
            };

            text = text.replace(/\\\(([\s\S]*?)\\\)/gm, (_match, content) => processInline(content));
            return replaceInlineMath(text, processInline);
        }
    },

    {
        priority: 56,
        apply: (text, renderer: RenderContext) => replaceLatexCommandCalls(
            unwrapLatexContentCommands(resolveLatexTextTransforms(text)),
            {
                name: 'ensuremath',
                requiredArgs: 1,
                render: call => renderMath(call.requiredArgs[0].content, false, renderer)
            }
        )
    },

    {
        priority: 55,
        apply: (text, renderer: RenderContext) => {
            const expanded = expandLatexTextMacros(text, renderer.metadata?.macros ?? {}, SEMANTIC_MACROS);
            return stripLatexDefinitions(stripLatexLayout(expanded, renderer));
        }
    },

    {
        priority: 60,
        apply: (text, renderer: RenderContext) => {
            text = replaceLatexCommandCalls(text, {
                name: 'label',
                optionalArgs: 1,
                requiredArgs: 1,
                render: call => renderer.protectHtml('raw', createHiddenLabelAnchor(call.requiredArgs[0].content))
            });

            text = text.replace(R_REF, (_match, type, labels) => {
                return renderer.protectHtml('ref', renderReferenceLinksHtml(labels.split(','), type === 'eqref' ? 'eqref' : 'ref'));
            });
            return text;
        }
    },

    {
        priority: 70,
        apply: (text, renderer: RenderContext) => {
            text = text.replace(R_CITATION, (_match, cmd, opt1, opt2, keys) => {
                const keyArray = splitLatexCitationKeys(keys);
                let pre = '';
                let post = '';
                if (opt2 !== undefined) { pre = opt1 ?? ''; post = opt2; }
                else if (opt1 !== undefined) { post = opt1; }
                return renderer.protectHtml('cite', renderCitationHtml(cmd, keyArray, { pre, post }, renderer));
            });
            return text;
        }
    },

    {
        priority: 71,
        apply: (text, renderer: RenderContext) => {
            const renderText = (value: string) => renderInlineLatexHtml(
                value,
                tex => renderMath(tex, false, renderer),
                renderer.metadata?.colors
            );
            const renderEntries = (entries: Iterable<BibEntry>) => {
                const items = Array.from(entries);
                return items.length
                    ? renderer.protectHtml('bib', renderBibliographyItemsHtml(items.map(entry => ({ key: entry.key, entry })), renderer, renderText))
                    : '';
            };
            text = text.replace(R_BIBLIOGRAPHY_STYLE, '');
            text = text.replace(new RegExp(R_ADDBIBRESOURCE, 'g'), '');
            text = text.replace(new RegExp(R_THEBIBLIOGRAPHY, 'gi'), (_match, content) =>
                renderEntries(BibTexParser.parseBibItems(content).values())
            );
            text = text.replace(/\\begin\{thebibliography\}(?:\{[^}]*\})?[\s\S]*/i, () =>
                renderEntries(renderer.bibEntries.values())
            );
            text = text.replace(/\\end\{thebibliography\}/gi, '');
            text = text.replace(new RegExp(R_BIBLIOGRAPHY, 'g'), () => {
                return renderer.protectHtml('bib', renderCitedBibliographyHtml(renderer.getCitedKeys(), renderer.bibEntries, renderer, renderText));
            });
            return text.replace(new RegExp(R_PRINTBIBLIOGRAPHY, 'g'), () => {
                return renderer.protectHtml('bib', renderCitedBibliographyHtml(renderer.getCitedKeys(), renderer.bibEntries, renderer, renderText));
            });
        }
    },

    {
        priority: 90,
        apply: (text, renderer: RenderContext) => {
            return text.replace(/\\([%#&])/g, (_match, char) => {
                const entity = char === '&' ? '&amp;' : char === '#' ? '&#35;' : '&#37;';
                return renderer.protectHtml('raw', entity);
            });
        }
    },

    {
        priority: 100,
        apply: (text, renderer: RenderContext) => {
            const quote = (html: string) => renderer.protectHtml('quote', html);
            const wrap = (content: string, open: string, close: string) => `${quote(open)}${content}${quote(close)}`;
            let processed = text.replace(/``([\s\S]*?)''/g, (_match, content) => wrap(content, '&ldquo;', '&rdquo;'));
            processed = processed.replace(/`([\s\S]*?)'/g, (_match, content) => wrap(content, '&lsquo;', '&rsquo;'));
            processed = processed.replace(/``/g, () => quote('&ldquo;'));
            processed = processed.replace(/`/g, () => quote('&lsquo;'));
            return processed;
        }
    },

    {
        priority: 119,
        apply: (text, renderer: RenderContext) => {
            return text.replace(/~/g, () => renderer.protectHtml('space', '&nbsp;'));
        }
    },

    {
        priority: 115,
        apply: (text, renderer: RenderContext) => replaceLatexLinkCommands(text, renderer)
    },

    {
        priority: 51,
        apply: (text, renderer: RenderContext) => replaceSiunitxCommands(text, tex => renderMath(tex, false, renderer))
    },

    {
        priority: 117,
        apply: (text, renderer: RenderContext) => replaceLatexInlineNotes(text, content =>
            renderer.protectHtml('note', renderInlineNoteHtml(renderInlineContent(content, renderer)))
        )
    },

    createFigureRule(),
    createAlgorithmRule(),
    createTableRule(),

    {
        priority: 145,
        apply: (text, renderer: RenderContext) => text
            .replace(new RegExp(`\\\\begin\\{(?:${REGEX_STR.QUOTE_ENVS})\\}`, 'gi'), () => `\n\n${renderer.protectHtml('quote-open', '<blockquote class="latex-quote">')}\n\n`)
            .replace(new RegExp(`\\\\end\\{(?:${REGEX_STR.QUOTE_ENVS})\\}`, 'gi'), () => `\n\n${renderer.protectHtml('quote-close', '</blockquote>')}\n\n`)
    },

    {
        priority: 146,
        apply: (text, renderer: RenderContext) => text
            .replace(new RegExp(`\\\\begin\\{(?:${REGEX_STR.ACKNOWLEDGMENT_ENVS})\\}(?:\\[([^\\]]*)\\])?`, 'gi'), (_match, title) => {
                const heading = renderInlineContent(title || 'Acknowledgments', renderer);
                return `\n\n${renderer.protectHtml('ack-open', `<section class="latex-acknowledgments"><h2>${heading}</h2>`)}\n\n`;
            })
            .replace(new RegExp(`\\\\end\\{(?:${REGEX_STR.ACKNOWLEDGMENT_ENVS})\\}`, 'gi'), () =>
                `\n\n${renderer.protectHtml('ack-close', '</section>')}\n\n`
            )
    },

    {
        priority: 150,
        apply: (text, renderer: RenderContext) => {
            const thmBeginRegex = new RegExp(`\\\\begin\\{(${REGEX_STR.THEOREM_ENVS})(\\*)?\\}(?:\\{.*?\\})?(?:\\[(.*?)\\])?`, 'g');
            const theoremOpening = (envName: string, optArg?: string, numbered = true, displayName = getTheoremDisplayName(envName)) => {
                const header = renderTheoremHeaderHtml(
                    renderInlineContent(displayName, renderer),
                    renderInlineContent(optArg, renderer),
                    numbered
                );
                return `\n\n${renderer.protectHtml('thm-open', `<div class="latex-theorem">${header}`)}\n\n`;
            };

            const customTheorems = Object.entries(renderer.metadata?.environments ?? {})
                .filter((entry): entry is [string, Extract<PreambleEnvironmentDefinition, { kind: 'theorem' }>] => entry[1].kind === 'theorem');
            if (customTheorems.length > 0) {
                const names = customTheorems.map(([name]) => escapeRegExp(name)).join('|');
                const definitions = new Map(customTheorems);
                text = text.replace(new RegExp(`\\\\begin\\{(${names})\\}(?:\\[(.*?)\\])?`, 'g'), (_match, envName, optArg) => {
                    const definition = definitions.get(envName)!;
                    return theoremOpening(envName, optArg, definition.numbered, definition.displayName);
                });
                text = text.replace(new RegExp(`\\\\end\\{(?:${names})\\}`, 'g'), () =>
                    `\n\n${renderer.protectHtml('thm-close', '</div>')}\n\n`
                );
            }
            text = text.replace(thmBeginRegex, (_match, envName, star, optArg) => theoremOpening(envName, optArg, !star));
            text = text.replace(
                new RegExp(`\\\\begin\\{restatable\\}(?:\\[([^\\]]*)\\])?\\s*\\{(${REGEX_STR.THEOREM_ENVS})\\}\\s*\\{[^{}]*\\}`, 'gi'),
                (_match, optArg, envName) => theoremOpening(envName, optArg)
            );

            const thmEndRegex = new RegExp(`\\\\end\\{(${REGEX_STR.THEOREM_ENVS})\\*?\\}`, 'g');
            text = text.replace(thmEndRegex, () => `\n\n${renderer.protectHtml('thm-close', '</div>')}\n\n`);
            text = text.replace(/\\end\{restatable\}/gi, () => `\n\n${renderer.protectHtml('thm-close', '</div>')}\n\n`);

            text = text.replace(new RegExp(`\\\\begin\\{(?:${REGEX_STR.PROOF_ENVS})\\}(?:\\[(.*?)\\])?`, 'gi'), (_match, optArg) => {
                const title = optArg ? `Proof (${renderInlineContent(optArg, renderer)}).` : `Proof.`;
                const heading = renderer.protectHtml('proof-title', `<strong>${title}</strong>`, 'inline');
                return `\n${renderer.protectHtml('raw', '<span class="no-indent-marker"></span>')}${heading} `;
            });
            return text.replace(new RegExp(`\\\\end\\{(?:${REGEX_STR.PROOF_ENVS})\\}`, 'gi'), () => ` ${renderer.protectHtml('raw', '<span style="float:right;">QED</span>')}\n`);
        }
    },

    {
        priority: 160,
        apply: (text, renderer: RenderContext) => {
            if (text.includes('\\maketitle')) {
                let titleBlock = '';
                const metadata = renderer.metadata;
                const processMeta = (value: string | undefined) => renderInlineContent(value, renderer);

                const safeTitle = processMeta(metadata?.title);
                const safeAuthors = renderMaketitleAuthorsHtml(
                    metadata?.authors ?? [],
                    metadata?.affiliations ?? [],
                    processMeta
                );
                const safeDate = processMeta(metadata?.date);
                const safeEditor = processMeta(metadata?.custom.editor);

                if (safeTitle) { titleBlock += `<h1 class="latex-title">${safeTitle}</h1>`; }
                if (safeAuthors) { titleBlock += safeAuthors; }
                if (safeEditor) { titleBlock += `<div class="latex-editor"><strong>Editor:</strong> ${safeEditor}</div>`; }
                if (safeDate) { titleBlock += `<div class="latex-date">${safeDate}</div>`; }

                text = text.replace(/\\maketitle.*/g, `\n\n` + renderer.protectHtml('meta', titleBlock) + `\n\n`);
                text = text.replace(/ \[meta:.*?\]/g, '');
            }

            text = text.replace(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/gi, (_match, content) => abstractSentinel(content));
            text = replaceLatexCommandCalls(text, [
                {
                    name: ['Abstract', 'abstract'],
                    requiredArgs: 1,
                    render: call => abstractSentinel(call.requiredArgs[0].content)
                },
                {
                    name: ['Keywords', 'keywords', 'Keyword', 'keyword'],
                    requiredArgs: 1,
                    render: call => keywordsSentinel(call.requiredArgs[0].content)
                }
            ]);

            const keywordsRegex = /(?:\\begin\{(?:IEEE)?keywords?\}([\s\S]*?)\\end\{(?:IEEE)?keywords?\}|\\noindent\{\\bf Keywords\}:\s*(.*))/gi;
            text = text.replace(keywordsRegex, (_match, contentA, contentB) => keywordsSentinel(contentA || contentB || ''));

            return text;
        }
    },

    {
        priority: 170,
        apply: (text, renderer: RenderContext) => {
            return replaceLatexCommandCalls(text, {
                name: SECTION_LEVELS,
                allowStar: true,
                optionalArgs: 1,
                requiredArgs: 1,
                render: call => {
                    const level = call.name;
                    const content = call.requiredArgs[0].content;
                    let prefix = '##';
                    if (level === 'subsection') { prefix = '###'; }
                    else if (level === 'subsubsection') { prefix = '####'; }
                    else if (level === 'paragraph') { prefix = '#####'; }
                    else if (level === 'subparagraph') { prefix = '######'; }

                    let numHtml = "";
                    if (!call.star && !['paragraph', 'subparagraph'].includes(level)) {
                        numHtml = `<span class="sn-cnt" data-type="sec"></span>. `;
                    }

                    if(numHtml) {numHtml = renderer.protectHtml('secnum', numHtml);}

                    return `\n${prefix} ${numHtml}${content.trim()}\n`;
                }
            });
        }
    },

    {
        priority: 180,
        apply: (text, renderer: RenderContext) => renderLatexLists(text, renderer)
    },

    {
        priority: 190,
        apply: (text, renderer: RenderContext) => {
            return resolveLatexStyles(text, createStyleHtmlProtector(renderer), renderer.metadata?.colors);
        }
    }
];

export const DEFAULT_BLOCK_DEPENDENCY_RULES: BlockDependencyRule[] = [
    ({ text, artifact, deps }) => {
        const hasMaketitle = artifact
            ? artifact.metadata.macros.includes('maketitle')
            : text.includes('\\maketitle');
        if (!hasMaketitle) { return []; }
        return [
            deps.metadata('title'),
            deps.metadata('date'),
            deps.metadata('authors'),
            deps.metadata('affiliations'),
            deps.metadata('custom.editor')
        ];
    },
    ({ text, artifact, deps }) => {
        const hasBibliography = artifact
            ? artifact.metadata.macros.some(macro => macro === 'bibliography' || macro === 'printbibliography')
            : R_BIBLIOGRAPHY.test(text) || R_PRINTBIBLIOGRAPHY.test(text);
        if (!hasBibliography) { return []; }
        return [deps.citedKeys()];
    }
];

export const SNAP_TEX_RULES = defineRuleRegistry({
    metadataExtractors: [
        BUILTIN_METADATA_EXTRACTOR,
        EDITOR_METADATA_EXTRACTOR
    ],
    renderRules: DEFAULT_RENDER_RULES,
    astRenderRules: DEFAULT_AST_RENDER_RULES,
    astMathRules: DEFAULT_AST_MATH_RULES,
    blockDependencyRules: DEFAULT_BLOCK_DEPENDENCY_RULES,
    splitterConfig: DEFAULT_SPLITTER_CONFIG,
    splitterRules: DEFAULT_SPLITTER_RULES
});

export function postProcessHtml(html: string): string {
    html = html.replace(/<p>\s*OOABSTRACT_STARTOO\s*<\/p>/g, '<div class="latex-abstract"><span class="latex-abstract-title">Abstract</span>');
    html = html.replace(/OOABSTRACT_STARTOO/g, '<div class="latex-abstract"><span class="latex-abstract-title">Abstract</span>');
    html = html.replace(/<p>\s*OOABSTRACT_ENDOO\s*<\/p>/g, '</div>');
    html = html.replace(/OOABSTRACT_ENDOO/g, '</div>');
    const keywordRegex = /<p>\s*OOKEYWORDS_STARTOO([\s\S]*?)OOKEYWORDS_ENDOO\s*<\/p>/g;
    html = html.replace(keywordRegex, (_match, content) => {
        return `<div class="latex-keywords"><strong>Keywords:</strong> ${content}</div>`;
    });
    return html;
}
