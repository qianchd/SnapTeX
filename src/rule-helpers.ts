import katex from 'katex';
import { BibTexParser } from './bib';
import { LATEX_CONTENT_WRAPPER_COMMANDS, LATEX_INLINE_NOTE_COMMANDS, LATEX_LAYOUT_BREAK_COMMANDS, LATEX_LAYOUT_SWITCH_COMMANDS, LATEX_OMITTED_ARGUMENT_COMMANDS, LATEX_PREVIEW_NOOP_COMMANDS, LATEX_PREVIEW_OMITTED_COMMANDS } from './patterns';
import type { AffiliationMetadata, AuthorMetadata, BibEntry, LatexMacroAlias, LatexMacroDefinition, RenderContext } from './types';
import {
    escapeHtml,
    escapeHtmlAttribute,
    escapeRegExp,
    expandLatexTextMacros,
    readLatexGroup,
    replaceLegacyRomanNumerals,
    replaceLatexCommandCalls,
    resolveLatexStyles,
    resolveLatexTextTransforms,
    sanitizeHttpUrlForAttribute,
    skipLatexWhitespace
} from './utils';

const BLOCK_LEVEL_HTML_PATTERN = /<(?:div|section|article|table|ul|ol|li|h[1-6]|p|blockquote|pre|canvas|script)\b|class="katex-display"/i;
const EMPTY_MACRO_ALIASES: readonly LatexMacroAlias[] = [];
const INLINE_LAYOUT_COMMAND_PATTERN = new RegExp(`\\\\(?:quad|qquad|${LATEX_LAYOUT_SWITCH_COMMANDS.join('|')})\\b\\s*`, 'g');
const INLINE_LAYOUT_BREAK_PATTERN = new RegExp(`\\\\(?:${LATEX_LAYOUT_BREAK_COMMANDS.join('|')})\\b\\s*`, 'g');
const PREVIEW_COMMAND_RULES = [
    { name: LATEX_PREVIEW_OMITTED_COMMANDS, optionalArgs: 1, render: () => '' },
    ...Object.entries(LATEX_OMITTED_ARGUMENT_COMMANDS).map(([name, requiredArgs]) => ({
        name, requiredArgs, optionalArgs: 1, allowStar: true, render: () => ' '
    }))
];
const CONTENT_WRAPPER_RULES = Object.entries(LATEX_CONTENT_WRAPPER_COMMANDS).map(([name, spec]) => ({
    name,
    requiredArgs: spec.requiredArgs,
    optionalArgs: spec.optionalArgs,
    argumentOrder: spec.argumentOrder,
    render: ({ requiredArgs }: { requiredArgs: readonly { content: string }[] }) =>
        `${spec.prefix ?? ''}${requiredArgs[spec.contentArg].content}${spec.suffix ?? ''}`
}));
const KATEX_COMPATIBILITY_MACROS = {
    ...Object.fromEntries(LATEX_PREVIEW_NOOP_COMMANDS.map(command => [`\\${command}`, '\\relax'])),
    '\\mathds': '\\mathbb{#1}',
    '\\mathbbm': '\\mathbb{#1}',
    '\\Bar': '\\overline{#1}',
    '\\Tilde': '\\widetilde{#1}',
    '\\Tr': '\\operatorname{Tr}',
    '\\nicefrac': '\\frac{#1}{#2}',
    '\\sfrac': '\\frac{#1}{#2}',
    '\\centernot': '\\not{#1}',
    '\\xspace': '\\ ',
    '\\textsc': '\\text{#1}',
    '\\textsl': '\\text{#1}',
    '\\nulldelimiterspace': '0pt',
    '\\protect': '\\relax',
    '\\normalcolor': '\\relax',
    '\\ensuremath': '#1',
    '\\hyperlink': '\\@secondoftwo{#1}{#2}',
    '\\hypertarget': '\\@firstoftwo{}{#1#2}',
    '\\Hy@raisedlink@left': '#1',
    '\\mathpalette': '\\mathchoice{#1{\\displaystyle}{#2}}{#1{\\textstyle}{#2}}{#1{\\scriptstyle}{#2}}{#1{\\scriptscriptstyle}{#2}}'
};
const KATEX_ALIAS_CACHE = new WeakMap<readonly LatexMacroAlias[], Record<string, string | object>>();

function createKatexMacros(
    macros: Readonly<Record<string, LatexMacroDefinition>>,
    aliases: readonly LatexMacroAlias[]
): Record<string, string | object> {
    const fallback = Object.fromEntries(Object.entries(macros).map(([name, definition]) => [name, katexMacroBody(definition)]));
    if (aliases.length === 0) {
        return { ...fallback, ...KATEX_COMPATIBILITY_MACROS };
    }

    let compiled = KATEX_ALIAS_CACHE.get(aliases);
    if (!compiled) {
        compiled = { ...KATEX_COMPATIBILITY_MACROS };
        for (const alias of aliases) {
            const previousTarget = compiled[alias.target];
            try {
                if (alias.targetDefinition) {
                    compiled[alias.target] = katexMacroBody(alias.targetDefinition);
                }
                katex.renderToString(`\\let${alias.name}${alias.target}`, {
                    macros: compiled,
                    globalGroup: true,
                    throwOnError: true,
                    strict: 'ignore',
                    trust: false
                });
            } catch {
                // Unsupported aliases stay absent while ordinary macros keep their string fallback.
            } finally {
                if (alias.targetDefinition) {
                    if (previousTarget === undefined) {
                        delete compiled[alias.target];
                    } else {
                        compiled[alias.target] = previousTarget;
                    }
                }
            }
        }
        KATEX_ALIAS_CACHE.set(aliases, compiled);
    }

    return {
        ...fallback,
        ...compiled,
        ...KATEX_COMPATIBILITY_MACROS
    };
}
const SIUNITX_COMMAND_ARGUMENTS = new Map<string, number>([
    ['num', 1], ['SI', 2], ['qty', 2], ['si', 1], ['unit', 1]
]);
const SIUNITX_UNIT_PARTS: Readonly<Record<string, string>> = {
    yocto: 'y', zepto: 'z', atto: 'a', femto: 'f', pico: 'p', nano: 'n', micro: '\\mu', milli: 'm', centi: 'c', deci: 'd',
    deca: 'da', hecto: 'h', kilo: 'k', mega: 'M', giga: 'G', tera: 'T', peta: 'P', exa: 'E', zetta: 'Z', yotta: 'Y',
    meter: 'm', metre: 'm', gram: 'g', second: 's', ampere: 'A', kelvin: 'K', mole: 'mol', candela: 'cd',
    hertz: 'Hz', newton: 'N', pascal: 'Pa', joule: 'J', watt: 'W', volt: 'V', ohm: '\\Omega', liter: 'L', litre: 'L', byte: 'B',
    percent: '\\%', degree: '^{\\circ}', celsius: '^{\\circ}C', per: '/', squared: '^{2}', cubed: '^{3}'
};

function normalizeSiunitxUnit(source: string): string {
    return source.replace(/\\([A-Za-z]+)\b/g, (match, name: string) => SIUNITX_UNIT_PARTS[name] ?? match);
}

export function siunitxMathSource(command: string, args: readonly string[]): string | undefined {
    if (!SIUNITX_COMMAND_ARGUMENTS.has(command)) { return undefined; }
    if (command === 'num') { return args[0] ?? ''; }
    const number = command === 'SI' || command === 'qty' ? `${args[0] ?? ''}\\,` : '';
    return `${number}\\mathrm{${normalizeSiunitxUnit(args[command === 'SI' || command === 'qty' ? 1 : 0] ?? '')}}`;
}

export function siunitxArgumentCount(command: string): number {
    return SIUNITX_COMMAND_ARGUMENTS.get(command) ?? 0;
}

export function replaceSiunitxCommands(text: string, render: (tex: string) => string = value => value): string {
    return replaceLatexCommandCalls(text, Array.from(SIUNITX_COMMAND_ARGUMENTS, ([name, requiredArgs]) => ({
        name,
        requiredArgs,
        optionalArgs: 1,
        render: call => render(siunitxMathSource(name, call.requiredArgs.map(argument => argument.content)) ?? '')
    })));
}

function katexMacroBody(definition: LatexMacroDefinition): string {
    const discarded = Array.from({ length: definition.argumentCount }, (_unused, index) => index + 1)
        .filter(index => !definition.body.includes(`#${index}`))
        .map(index => `\\@firstoftwo{}{#${index}}`)
        .join('');
    return discarded + definition.body;
}

function normalizeStarredMacroCalls(tex: string, macros: Readonly<Record<string, LatexMacroDefinition>>): string {
    const names = Object.entries(macros)
        .filter(([, definition]) => definition.allowStar)
        .map(([name]) => escapeRegExp(name));
    return names.length > 0 ? tex.replace(new RegExp(`(?:${names.join('|')})\\*`, 'g'), match => match.slice(0, -1)) : tex;
}

function normalizeKatexIntertext(content: string): string {
    const parts = content.split(/(?<!\\)\$((?:\\.|[^$])*)\$/);
    return `${parts.map((part, index) => index % 2 ? part : `\\text{${part}}`).join('')}\\\\`;
}

function normalizeKatexSource(tex: string): string {
    tex = replaceLatexCommandCalls(replaceSiunitxCommands(stripLatexPreviewCommands(tex)), [
        {
            name: 'MoveEqLeft',
            optionalArgs: 1,
            requiredArgs: 0,
            render: () => ''
        },
        {
            name: 'hfill',
            requiredArgs: 0,
            render: () => ''
        },
        {
            name: 'scalebox',
            requiredArgs: 2,
            render: call => call.requiredArgs[1].content.trim().replace(/^\$([\s\S]*)\$$/, '$1')
        },
        {
            name: 'IEEEeqnarraymulticol',
            requiredArgs: 3,
            render: call => call.requiredArgs[2].content
        },
        {
            name: 'intertext',
            requiredArgs: 1,
            render: call => normalizeKatexIntertext(call.requiredArgs[0].content)
        },
        {
            name: 'shortintertext',
            requiredArgs: 1,
            render: call => normalizeKatexIntertext(call.requiredArgs[0].content)
        }
    ]);
    tex = tex.replace(/(\\begin\{array\}\s*)\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_match, opening, columns: string) => {
        return `${opening}{${columns.replace(/@\{[^{}]*\}/g, '')}}`;
    });
    tex = tex.replace(
        /\\begin\{picture\}\s*\([^)]*\)(?:\([^)]*\))?\s*\\circle(\*)?\s*\{[^{}]*\}\s*\\end\{picture\}/g,
        (_match, filled: string | undefined) => filled ? '\\bullet' : '\\circ'
    );
    if (/\\begin\{(?:aligned|alignedat|split)\}/.test(tex)) {
        tex = replaceLatexCommandCalls(tex, {
            name: 'tag',
            requiredArgs: 1,
            render: call => `\\qquad\\text{(${call.requiredArgs[0].content})}`
        });
    }
    return tex;
}

export function normalizeOptimizationEnvironmentForKatex(content: string, envName: string): string | undefined {
    let index = skipLatexWhitespace(content, 0);
    const format = content.slice(index).match(/^\|[^|]*\|/);
    if (format) { index += format[0].length; }

    const header: string[] = [];
    for (let count = 0; count < 4; count++) {
        const group = readLatexGroup(content, index);
        if (!group) { return undefined; }
        header.push(group.content);
        index = group.end;
    }

    const constraints: string[] = [];
    const constraintRegex = /\\addConstraint\b/g;
    constraintRegex.lastIndex = index;
    while (constraintRegex.exec(content)) {
        const args: string[] = [];
        let cursor = constraintRegex.lastIndex;
        for (let count = 0; count < 3; count++) {
            const group = readLatexGroup(content, cursor);
            if (!group) { break; }
            args.push(group.content);
            cursor = group.end;
        }
        if (args.length > 0) {
            constraints.push(args.join(' '));
            constraintRegex.lastIndex = cursor;
        }
    }

    const operation = envName.startsWith('max') ? 'maximize' : 'minimize';
    const rows = [
        `\\operatorname*{${operation}}_{${header[0]}} & ${header[1]}`,
        ...constraints.map((constraint, row) => `${row === 0 ? '\\text{subject to}\\quad ' : ''}& ${constraint}`)
    ];
    return `\\begin{aligned}${rows.join('\\\\')}\\end{aligned}${header[2]}${header[3]}`;
}

interface CitationPart {
    key: string;
    author?: string;
    year?: string;
    number: number;
}

interface CitationFormat {
    text(value: string): string;
    option(value: string): string;
    author(value: string): string;
    link(value: string, key: string): string;
}

function renderCitation(
    command: string,
    keys: readonly string[],
    options: { pre?: string; post?: string },
    renderer: Pick<RenderContext, 'resolveCitation' | 'bibEntries'>,
    format: CitationFormat
): string {
    const pre = format.option(options.pre ?? '');
    const post = format.option(options.post ?? '');
    const prefix = pre ? `${pre} ` : '';
    const parts: CitationPart[] = keys.map(key => {
        const entry = renderer.bibEntries.get(key);
        return {
            key,
            number: renderer.resolveCitation(key),
            author: entry ? BibTexParser.getShortAuthor(entry) : undefined,
            year: entry ? entry.fields.year || entry.fields.date || 'n.d.' : undefined
        };
    });
    const renderYear = (part: CitationPart, isLast: boolean) => {
        if (!part.year) { return `[${format.text(part.key)}?]`; }
        const suffix = isLast && post ? `, ${post}` : '';
        return format.link(`${format.text(part.year)}${suffix}`, part.key);
    };

    if (command === 'citet' || command === 'citealt' || command === 'textcite') {
        return prefix + parts.map((part, index) => part.author
            ? `${format.author(part.author)} ${command === 'citealt' ? renderYear(part, index === parts.length - 1) : `(${renderYear(part, index === parts.length - 1)})`}`
            : renderYear(part, index === parts.length - 1)
        ).join(', ');
    }
    if (command === 'citeyear' || command === 'citeyearpar') {
        const years = prefix + parts.map((part, index) => renderYear(part, index === parts.length - 1)).join(', ');
        return command === 'citeyearpar' ? `(${years})` : years;
    }
    if (command === 'citeauthor') {
        return prefix + parts.map(part => part.author ? format.author(part.author) : format.text(part.key)).join(', ');
    }
    if (command === 'citenum') {
        const numbers = parts.map(part => format.link(String(part.number), part.key)).join(', ');
        return `${prefix}${numbers}${post ? `, ${post}` : ''}`;
    }

    let content = parts.map(part => part.author && part.year
        ? format.link(`${format.author(part.author)}, ${format.text(part.year)}`, part.key)
        : `[${format.text(part.key)}?]`
    ).join('; ');
    if (prefix) { content = prefix + content; }
    if (post) { content += `, ${post}`; }
    return command === 'citealp' ? content : `(${content})`;
}

function renderHtmlAuthor(author: string): string {
    return escapeHtml(author).replace(/\bet al\.$/, '<em>et al.</em>');
}

function escapeLatexText(text: string): string {
    return text.replace(/([#$%&_{}])/g, '\\$1');
}

export function renderCitationHtml(
    command: string,
    keys: readonly string[],
    options: { pre?: string; post?: string },
    renderer: Pick<RenderContext, 'resolveCitation' | 'bibEntries'>
): string {
    return renderCitation(command, keys, options, renderer, {
        text: escapeHtml,
        option: escapeHtml,
        author: renderHtmlAuthor,
        link: (value, key) => `<a href="#ref-${escapeHtmlAttribute(key)}" class="latex-cite-link">${value}</a>`
    });
}

export function renderCitationTex(
    command: string,
    keys: readonly string[],
    options: { pre?: string; post?: string },
    renderer: Pick<RenderContext, 'resolveCitation' | 'bibEntries'>
): string {
    return renderCitation(command, keys, options, renderer, {
        text: escapeLatexText,
        option: value => value,
        author: value => escapeLatexText(value).replace(/\bet al\.$/, '\\emph{et al.}'),
        link: value => value
    });
}

export function hasBlockLevelHtml(html: string): boolean {
    return BLOCK_LEVEL_HTML_PATTERN.test(html);
}

/** Calls KaTeX without rewriting source; each render backend owns its compatibility transforms. */
export function renderKatexHtml(
    tex: string,
    displayMode: boolean,
    macros: Readonly<Record<string, LatexMacroDefinition>>,
    aliases: readonly LatexMacroAlias[] = EMPTY_MACRO_ALIASES
): string {
    try {
        tex = normalizeKatexSource(normalizeStarredMacroCalls(tex, macros));
        const options = {
            displayMode,
            macros: createKatexMacros(macros, aliases),
            throwOnError: false,
            errorColor: '#cc0000',
            globalGroup: true,
            trust: false
        };
        const html = katex.renderToString(tex, options);
        if (!html.includes('katex-error')) { return html; }

        const expanded = normalizeKatexSource(expandLatexTextMacros(tex, macros));
        return expanded === tex ? html : katex.renderToString(expanded, options);
    } catch {
        return '<span style="color:red">Math Error</span>';
    }
}

/**
 * Renders TeX math through KaTeX and protects the generated HTML from Markdown.
 */
export function renderMath(tex: string, displayMode: boolean, renderer: RenderContext): string {
    const compatibleTex = replaceLegacyRomanNumerals(tex).replace(/\\mbox\b/g, '\\text');
    return renderer.protectHtml('math', renderKatexHtml(
        compatibleTex,
        displayMode,
        renderer.currentMacros,
        renderer.metadata?.macroAliases
    ));
}

export function renderIncludeGraphicsHtml(imgPath: string): string {
    const cleanPath = imgPath.trim();
    const safePath = escapeHtmlAttribute(cleanPath);
    if (cleanPath.toLowerCase().endsWith('.pdf')) {
        const canvasId = `pdf-${Math.random().toString(36).slice(2, 11)}`;
        return `<canvas id="${canvasId}" data-req-path="${safePath}" style="width:100%; max-width:100%; display:block; margin:0 auto;"></canvas>`;
    }
    return `<img src="LOCAL_IMG:${safePath}" style="max-width:100%; display:block; margin:0 auto;">`;
}

export function normalizeMathEnvironmentForKatex(tex: string, envName?: string): string {
    const normalized = envName?.toLowerCase().replace(/\*$/, '');
    if (normalized === 'alignat' || normalized === 'ieeeeqnarray') {
        const columnCount = readLatexGroup(tex, 0);
        if (columnCount && (normalized === 'ieeeeqnarray' || /^\d+$/.test(columnCount.content.trim()))) {
            tex = tex.slice(columnCount.end).trimStart();
        }
    }
    if (normalized && ['align', 'flalign', 'alignat', 'multline', 'eqnarray', 'ieeeeqnarray'].includes(normalized)) {
        return `\\begin{aligned}\n${tex}\n\\end{aligned}`;
    }
    return normalized === 'gather' ? `\\begin{gathered}\n${tex}\n\\end{gathered}` : tex;
}

export function renderInlineLatexHtml(
    text: string | undefined,
    renderMathHtml: (tex: string) => string,
    colors?: Readonly<Record<string, string>>
): string {
    if (!text) { return ''; }

    const htmlFragments: string[] = [];
    const protectHtml = (html: string) => {
        const token = `\uE000SNAP_INLINE_HTML_${htmlFragments.length}\uE001`;
        htmlFragments.push(html);
        return token;
    };

    const lineBreak = protectHtml('<br/>');
    let rendered = replaceLatexInlineNotes(unwrapLatexContentCommands(stripLatexPreviewCommands(resolveLatexTextTransforms(text))), content =>
        protectHtml(renderInlineNoteHtml(renderInlineLatexHtml(content, renderMathHtml, colors)))
    );
    rendered = replaceLatexLinks(rendered, content => renderInlineLatexHtml(content, renderMathHtml, colors), protectHtml);
    rendered = rendered
        .replace(INLINE_LAYOUT_BREAK_PATTERN, lineBreak)
        .replace(INLINE_LAYOUT_COMMAND_PATTERN, ' ')
        .replace(/<br\s*\/?>/gi, lineBreak)
        .replace(/\\(?:and|And)\b/g, lineBreak)
        .replace(/\\\\/g, lineBreak)
        .replace(/\$((?:\\.|[^\\$])*)\$/g, (_match, content: string) => protectHtml(renderMathHtml(content.trim())));
    rendered = resolveLatexStyles(rendered, html => protectHtml(html), colors);

    return escapeHtml(rendered)
        .replace(/\uE000SNAP_INLINE_HTML_(\d+)\uE001/g, (_match, index: string) => htmlFragments[Number(index)] ?? '')
        .replace(/~/g, '&nbsp;');
}

export function unwrapLatexContentCommands(text: string): string {
    for (let pass = 0; pass < 8; pass++) {
        const next = replaceLatexCommandCalls(text, CONTENT_WRAPPER_RULES);
        if (next === text) { break; }
        text = next;
    }
    return text;
}

export function replaceLatexLinks(
    text: string,
    renderContent: (content: string) => string,
    protectHtml: (html: string) => string
): string {
    return replaceLatexCommandCalls(text, [
        {
            name: 'href',
            requiredArgs: 2,
            render: call => {
                const content = renderContent(call.requiredArgs[1].content);
                return protectHtml(renderExternalLinkHtml(call.requiredArgs[0].content, content, 'latex-href') ?? content);
            }
        },
        {
            name: 'url',
            requiredArgs: 1,
            render: call => {
                const url = call.requiredArgs[0].content.trim();
                return protectHtml(renderExternalLinkHtml(url, escapeHtml(url), 'latex-url') ?? escapeHtml(url));
            }
        }
    ]);
}

export function stripLatexPreviewCommands(text: string): string {
    return replaceLatexCommandCalls(text, PREVIEW_COMMAND_RULES);
}

export function replaceLatexInlineNotes(text: string, renderNote: (content: string) => string): string {
    return replaceLatexCommandCalls(text, {
        name: LATEX_INLINE_NOTE_COMMANDS,
        optionalArgs: 1,
        requiredArgs: 1,
        render: call => renderNote(call.requiredArgs[0].content)
    });
}

export function renderInlineNoteHtml(contentHtml: string): string {
    return `<em>(${contentHtml.trim()})</em><br/>`;
}

export function normalizeLatexKeywordSeparators(content: string): string {
    return content.replace(/\s*\\sep\b\s*/g, ', ');
}

export function renderNumberedEquationHtml(mathHtml: string, numberHtml: string, trailingHtml = ''): string {
    return `<div class="equation-container" style="position: relative; width: 100%;">
${mathHtml}
<span class="eq-no" style="position: absolute; right: 0; top: 50%; transform: translateY(-50%); pointer-events: none;">${numberHtml}</span>
</div>${trailingHtml}`;
}

export function renderTheoremHeaderHtml(displayNameHtml: string, titleHtml = '', numbered = true): string {
    const number = numbered ? ' <span class="sn-cnt" data-type="thm"></span>' : '';
    const title = titleHtml ? `</strong>&nbsp;(${titleHtml}).` : '.</strong>';
    return `<span class="latex-thm-head"><strong class="latex-theorem-header">${displayNameHtml}${number}${title}</span>&nbsp; `;
}

/**
 * Creates a protected reference placeholder that scanner numbering fills later.
 */
export function createRefLink(key: string, renderer: RenderContext, type: 'ref' | 'eqref' = 'ref'): string {
    const safeKey = escapeHtmlAttribute(key);
    const html = `<a href="#${safeKey}" class="sn-ref" data-key="${safeKey}" style="color:inherit; text-decoration:none;">?</a>`;
    const token = renderer.protectHtml('ref', html);
    if (type === 'eqref') {
        return `(\\text{${token}})`;
    }
    return `\\text{${token}}`;
}

export function renderReferenceLinksHtml(labels: readonly string[], type: 'ref' | 'eqref' = 'ref'): string {
    const links = labels
        .map(label => label.trim())
        .filter(Boolean)
        .map(label => {
            const safeLabel = escapeHtmlAttribute(label);
            return `<a href="#${safeLabel}" class="latex-link latex-ref sn-ref" data-key="${safeLabel}">?</a>`;
        })
        .join(', ');
    return type === 'eqref' ? `(${links})` : links;
}

export function renderMaketitleAuthorsHtml(
    authors: readonly AuthorMetadata[],
    affiliations: readonly AffiliationMetadata[],
    renderValue: (value: string | undefined) => string
): string {
    if (authors.length === 0) { return ''; }

    const isPlainAuthorBlock = authors.length === 1
        && authors[0].emails.length === 0
        && authors[0].affiliationIds.length === 0
        && affiliations.length === 0;
    if (isPlainAuthorBlock) {
        return `<div class="latex-author">${renderValue(authors[0].name)}</div>`;
    }

    const labelById = new Map(affiliations.map((affiliation, index) => [affiliation.id, String(index + 1)]));
    const authorItems = authors.map(author => {
        const labels = author.affiliationIds.map(id => labelById.get(id) ?? id).filter(Boolean);
        const marker = labels.length > 0 ? `<sup>${escapeHtml(labels.join(','))}</sup>` : '';
        const emailHtml = author.emails.length > 0
            ? `<span class="latex-author-email">${author.emails.map(email => renderValue(email)).join(', ')}</span>`
            : '';
        return `<span class="latex-author-item">${renderValue(author.name)}${marker}${emailHtml}</span>`;
    }).join('');
    const affiliationHtml = affiliations.length > 0
        ? `<div class="latex-affiliations">${affiliations.map((affiliation, index) => `<div><sup>${index + 1}</sup> ${renderValue(affiliation.text)}</div>`).join('')}</div>`
        : '';
    return `<div class="latex-author">${authorItems}</div>${affiliationHtml}`;
}

export function renderBibliographyItemsHtml(
    items: Array<{ key: string; entry?: BibEntry }>,
    renderer: Pick<RenderContext, 'protectHtml'>,
    renderText?: (value: string) => string
): string {
    const body = items.map(({ key, entry }) => {
        const safeKey = escapeHtmlAttribute(key);
        const content = entry
            ? BibTexParser.formatEntry(entry, renderer, renderText)
            : `<span style="color:red">Bib entry '${escapeHtml(key)}' not found.</span>`;
        return `<div class="bib-item" id="ref-${safeKey}" style="margin-bottom: 0.8em; padding-left: 2em; text-indent: -2em;">${content}</div>`;
    }).join('');
    return `<h2 class="latex-bibliography-header">References</h2><div class="latex-bibliography-list">${body}</div>`;
}

export function renderCitedBibliographyHtml(
    citedKeys: readonly string[],
    bibEntries: ReadonlyMap<string, BibEntry>,
    renderer: Pick<RenderContext, 'protectHtml'>,
    renderText?: (value: string) => string
): string {
    const keys = Array.from(new Set(citedKeys)).sort((left, right) =>
        (bibEntries.get(left)?.fields.author ?? '').localeCompare(bibEntries.get(right)?.fields.author ?? '')
    );
    return keys.length === 0
        ? '<div class="latex-bibliography error">No citations found.</div>'
        : renderBibliographyItemsHtml(keys.map(key => ({ key, entry: bibEntries.get(key) })), renderer, renderText);
}

export function renderExternalLinkHtml(rawUrl: string, contentHtml: string, className: string): string | undefined {
    const safeHref = sanitizeHttpUrlForAttribute(rawUrl);
    return safeHref
        ? `<a href="${safeHref}" class="latex-link ${className}" target="_blank" rel="noopener noreferrer">${contentHtml}</a>`
        : undefined;
}

export function createStyleHtmlProtector(renderer: RenderContext): (html: string, mode?: Parameters<RenderContext['protectHtml']>[2]) => string {
    return (html, mode = 'inline') => renderer.protectHtml('style', html, mode);
}

/**
 * Recovers protection tokens that were embedded in ignored float regions.
 */
export function recoverPreservedTokens(text: string): string {
    return (text.match(/XSNAP:[a-zA-Z0-9_-]+:\d+Y/g) ?? []).join('');
}

export function renderCaptionContent(captionText: string, renderer: RenderContext): string {
    const withMath = captionText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (_match: string, content: string) => {
        return renderMath(content.trim(), false, renderer);
    });
    return renderer.renderInline(resolveLatexStyles(withMath, createStyleHtmlProtector(renderer), renderer.metadata?.colors));
}

export function renderCaptionHtml(className: string, contentHtml: string, prefixHtml = ''): string {
    return `<div class="${className}">${prefixHtml}${contentHtml}</div>`;
}

export function renderNumberedCaptionPrefix(label: string, counterType: 'fig' | 'tbl' | 'alg'): string {
    return `<strong>${label} <span class="sn-cnt" data-type="${counterType}"></span>:</strong> `;
}

export function renderSubfigureWidthStyle(widthSpec: string): string {
    const basis = `${latexRelativeWidthPercent(widthSpec) ?? 100}%`;
    return `flex: 1 1 ${basis}; max-width: ${basis};`;
}

export function renderSubfigureHtml(bodyHtml: string, captionHtml: string, widthSpec: string, hiddenHtml = ''): string {
    return `<div class="latex-subfigure" style="${renderSubfigureWidthStyle(widthSpec)}">${bodyHtml}${captionHtml}${hiddenHtml}</div>`;
}

export function latexRelativeWidthPercent(widthSpec: string): number | undefined {
    if (/^\s*\\(?:textwidth|linewidth)\s*$/.test(widthSpec)) { return 100; }
    const fraction = widthSpec.match(/([0-9]*\.?[0-9]+)\s*\\(?:textwidth|linewidth)/);
    return fraction ? Math.max(1, Math.min(100, Number((Number(fraction[1]) * 100).toFixed(3)))) : undefined;
}
