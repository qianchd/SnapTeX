import {
    BUILTIN_METADATA_EXTRACTOR,
    readMetadataCommand
} from './metadata';
import {
    toRoman,
    createHiddenLabelAnchor,
    escapeHtml,
    escapeHtmlAttribute,
    extractAndHideLabels,
    splitLatexCitationKeys,
    replaceLatexCommandCalls,
    resolveLatexStyles,
    sanitizeHttpUrlForAttribute,
    stripLatexComments
} from './utils';
import { AffiliationMetadata, AuthorMetadata, BibEntry, BlockDependencyRule, MetadataExtractor, PreprocessRule, RenderContext, RuleRegistry, SplitterConfig, SplitterRule } from './types';
import { BibTexParser } from './bib';
import {
    REGEX_STR,
    R_LABEL,
    R_REF,
    R_CITATION,
    R_BIBLIOGRAPHY,
    R_BIBLIOGRAPHY_STYLE,
    R_THEBIBLIOGRAPHY,
    getTheoremDisplayName
} from './patterns';
import { createRefLink, protectInlineStyle, renderMath } from './rule-helpers';
import { createTikzPictureRule } from './rule-tikz';
import { createAlgorithmRule, createFigureRule, createTableRule } from './rule-floats';

function renderExternalLink(rawUrl: string, safeContent: string, className: string, renderer: RenderContext): string {
    const safeHref = sanitizeHttpUrlForAttribute(rawUrl);

    if (!safeHref) {
        return renderer.protectHtml('link-text', safeContent);
    }

    return renderer.protectHtml(
        'link',
        `<a href="${safeHref}" class="latex-link ${className}" target="_blank" rel="noopener noreferrer">${safeContent}</a>`
    );
}

function replaceLatexLinkCommands(text: string, renderer: RenderContext): string {
    return replaceLatexCommandCalls(text, [
        {
            name: 'href',
            requiredArgs: 2,
            render: call => {
                const styledContent = resolveLatexStyles(call.requiredArgs[1].content, protectInlineStyle(renderer));
                return renderExternalLink(call.requiredArgs[0].content, escapeHtml(styledContent), 'latex-href', renderer);
            }
        },
        {
            name: 'url',
            requiredArgs: 1,
            render: call => renderExternalLink(call.requiredArgs[0].content, escapeHtml(call.requiredArgs[0].content.trim()), 'latex-url', renderer)
        }
    ]);
}

interface CitationPart {
    error: boolean;
    key: string;
    author: string;
    year: string;
}

function replaceMathRefs(content: string, renderer: RenderContext): string {
    return content.replace(/\\(ref|eqref)\*?\{([^}]+)\}/g, (_match, reftype, key) => createRefLink(key, renderer, reftype));
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

export function defineMetadataExtractor(extractor: MetadataExtractor): MetadataExtractor {
    return extractor;
}

export function defineRuleRegistry(registry: RuleRegistry): RuleRegistry {
    return {
        metadataExtractors: [...registry.metadataExtractors],
        renderRules: [...registry.renderRules].sort((a, b) => a.priority - b.priority),
        blockDependencyRules: [...registry.blockDependencyRules],
        splitterConfig: { ...registry.splitterConfig },
        splitterRules: [...registry.splitterRules]
    };
}

const envPattern = (fragment: string, allowStar = false) => new RegExp(`^(${fragment})${allowStar ? '\\*?' : ''}$`);

// User-facing splitter settings. Long protected constructs get a larger window
// before the splitter treats them as malformed and resumes emergency splitting.
export const DEFAULT_SPLITTER_CONFIG: SplitterConfig = {
    maxBlockLines: 40,
    maxNoEmergencySplitLines: 400
};

export const DEFAULT_SPLITTER_RULES: SplitterRule[] = [
    { name: 'ignored-environments', kind: 'ignored-env', envPattern: envPattern(REGEX_STR.SPLITTER_IGNORED) },
    { name: 'split-environments', kind: 'split-env', envPattern: envPattern(`${REGEX_STR.SPLITTER_MAJOR}|thebibliography|tikzpicture`, true) },
    { name: 'tikz-and-bibliography', kind: 'no-emergency-split-env', envPattern: envPattern('thebibliography|tikzpicture') },
    {
        name: 'long-brace-groups',
        kind: 'no-emergency-split-begin-token',
        beginTokenPattern: /(?:\{\\(?:color\{[a-zA-Z0-9]+\}|(?:bf|it|sf|rm|tt)\b)|\\resizebox\s*\{[^{}]*\}\s*\{[^{}]*\}\s*\{)/
    },
    { name: 'emergency-split-math-end', kind: 'emergency-split-end-env', envPattern: envPattern(REGEX_STR.MATH_ENVS, true) }
];

function renderMetadataValue(value: string | undefined, renderer: RenderContext): string {
    if (!value) { return ''; }
    const lineBreakToken = renderer.protectHtml('meta-br', '<br/>');
    let rendered = value.replace(/<br\s*\/?>/gi, lineBreakToken);
    rendered = replaceLatexCommandCalls(rendered, {
        name: 'footnote',
        requiredArgs: 1,
        render: () => ''
    });
    rendered = rendered.replace(/\\(?:and|And)\b/g, lineBreakToken);
    rendered = rendered.replace(/\\\\/g, lineBreakToken);
    rendered = rendered.replace(/\$((?:\\.|[^\\$])+?)\$/g, (_match: string, content: string) => renderMath(content.trim(), false, renderer));
    rendered = resolveLatexStyles(rendered, protectInlineStyle(renderer));
    return escapeHtml(rendered);
}

/**
 * Complete custom metadata example.
 *
 * It stores \editor{...} as metadata.custom.editor. The default \maketitle
 * rule reads this custom field and refreshes when it changes.
 */
export const EDITOR_METADATA_EXTRACTOR = defineMetadataExtractor({
    name: 'editor-example',
    extract: source => {
        const editor = readMetadataCommand(source, 'editor');
        return editor
            ? { custom: { editor: editor.content }, ranges: [editor.range] }
            : {};
    }
});

function renderMaketitleAuthors(
    authors: readonly AuthorMetadata[],
    affiliations: readonly AffiliationMetadata[],
    processMeta: (value: string | undefined) => string
): string {
    if (authors.length === 0) { return ''; }

    const isPlainAuthorBlock = authors.length === 1
        && authors[0].emails.length === 0
        && authors[0].affiliationIds.length === 0
        && affiliations.length === 0;
    if (isPlainAuthorBlock) {
        return `<div class="latex-author">${processMeta(authors[0].name)}</div>`;
    }

    const labelById = new Map(affiliations.map((affiliation, index) => [affiliation.id, String(index + 1)]));
    const authorItems = authors.map(author => {
        const labels = author.affiliationIds.map(id => labelById.get(id) ?? id).filter(Boolean);
        const marker = labels.length > 0 ? `<sup>${escapeHtml(labels.join(','))}</sup>` : '';
        const emailHtml = author.emails.length > 0
            ? `<span class="latex-author-email">${author.emails.map(email => processMeta(email)).join(', ')}</span>`
            : '';
        return `<span class="latex-author-item">${processMeta(author.name)}${marker}${emailHtml}</span>`;
    }).join('');
    return `<div class="latex-author">${authorItems}</div>` + (affiliations.length > 0
        ? `<div class="latex-affiliations">${affiliations.map((affiliation, index) => `<div><sup>${index + 1}</sup> ${processMeta(affiliation.text)}</div>`).join('')}</div>`
        : '');
}

function abstractSentinel(content: string): string {
    const trimmed = content.trim();
    return trimmed ? `\n\nOOABSTRACT_STARTOO\n\n${trimmed}\n\nOOABSTRACT_ENDOO\n\n` : '';
}

function keywordsSentinel(content: string): string {
    const trimmed = content.trim();
    return trimmed ? `\n\nOOKEYWORDS_STARTOO${trimmed}OOKEYWORDS_ENDOO\n\n` : '';
}

function renderBibliographyItems(items: Array<{ key: string; entry?: BibEntry }>, renderer: RenderContext): string {
    let html = `<h2 class="latex-bibliography-header">References</h2><div class="latex-bibliography-list">`;
    items.forEach(({ key, entry }) => {
        const content = entry
            ? BibTexParser.formatEntry(entry, renderer)
            : `<span style="color:red">Bib entry '${escapeHtml(key)}' not found.</span>`;
        const safeKey = escapeHtmlAttribute(key);
        html += `<div class="bib-item" id="ref-${safeKey}" style="margin-bottom: 0.8em; padding-left: 2em; text-indent: -2em;">${content}</div>`;
    });
    return renderer.protectHtml('bib', html + `</div>`);
}

export const DEFAULT_RENDER_RULES: PreprocessRule[] = [
    {
        name: 'clean_comments',
        priority: 5,
        apply: text => stripLatexComments(text)
    },

    createTikzPictureRule(),

    {
        name: 'escaped_char_dollar',
        priority: 10,
        apply: (text, renderer: RenderContext) => {
            return text.replace(/\\([$])/g, () => renderer.protectHtml('raw', '&#36;'));
        }
    },

    {
        name: 'clean_layout_cmds',
        priority: 15,
        apply: (text, renderer: RenderContext) => {

            text = text.replace(/\\(baselineskip|parskip|parindent)\s*=?\s*[-+]?\d+(?:\.\d+)?\s*[a-zA-Z]{2}\s*/g, '');
            text = text.replace(/\\(vspace|hspace)\*?\{[^}]+\}\s*/g, '');
            text = text.replace(/\\(setlength|addtolength)\{[^}]+\}\{[^}]+\}\s*/g, '');

            text = text.replace(/\\noindent\s*/g, () => renderer.protectHtml('raw', '<span class="no-indent-marker"></span>'));

            return text;
        }
    },

    {
        name: 'mbox',
        priority: 20,
        apply: (text) => {
            return text.replace(/\\mbox/g, '\\text');
        }
    },

    {
        name: 'romannumeral',
        priority: 30,
        apply: (text) => {
            return text.replace(/\\(Rmnum|rmnum|romannumeral)\s*\{?(\d+)\}?/g, (_match, cmd, numStr) => {
                return toRoman(parseInt(numStr), cmd === 'Rmnum');
            });
        }
    },

    {
        name: 'display_math',
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

                if (envName) {
                    const name = envName.toLowerCase();
                    if (['align', 'flalign', 'alignat', 'multline'].includes(name)) {
                        finalMath = `\\begin{aligned}\n${finalMath}\n\\end{aligned}`;
                    } else if (name === 'gather') {
                        finalMath = `\\begin{gathered}\n${finalMath}\n\\end{gathered}`;
                    }
                }

                const protectedTag = renderMath(finalMath, true, renderer);

                const afterMatch = fullString.substring(offset + match.length);
                const isFollowedByText = /^\s*\S/.test(afterMatch) && !/^\s*\n\n/.test(afterMatch);

                const hiddenLabels = hiddenHtml ? renderer.protectHtml('raw', hiddenHtml) : '';
                let result = protectedTag + hiddenLabels;
                if (eqNumHTML) {
                    result = renderer.protectHtml('math-block', `<div class="equation-container" style="position: relative; width: 100%;">
                                ${protectedTag}
                                <span class="eq-no" style="position: absolute; right: 0; top: 50%; transform: translateY(-50%); pointer-events: none;">
                                    ${eqNumHTML}
                                </span>
                            </div>${hiddenLabels}`);
                }
                return result + (isFollowedByText ? renderer.protectHtml('raw', '<span class="no-indent-marker"></span>') : '');
            });
        }
    },

    {
        name: 'inline_math',
        priority: 50,
        apply: (text, renderer: RenderContext) => {
            const processInline = (content: string) => {
                const safeContent = replaceMathRefs(content, renderer);
                return renderMath(safeContent, false, renderer);
            };

            text = text.replace(/\\\(([\s\S]*?)\\\)/gm, (_match, content) => processInline(content));
            return text.replace(/(\\?)\$((?:\\.|[^\\$])*)\$/gm, (match, backslash, content) => {
                if (backslash === '\\') { return match; }
                return processInline(content);
            });
        }
    },

    {
        name: 'refs_and_labels',
        priority: 60,
        apply: (text, renderer: RenderContext) => {
            text = text.replace(new RegExp(R_LABEL, 'g'), (_match, labelName) => {
                return renderer.protectHtml('raw', createHiddenLabelAnchor(labelName));
            });

            text = text.replace(R_REF, (_match, type, labels) => {
                const htmlLinks = labels.split(',').map((label: string) => {
                    label = label.trim();
                    const safeLabel = escapeHtmlAttribute(label);
                    return `<a href="#${safeLabel}" class="latex-link latex-ref sn-ref" data-key="${safeLabel}">?</a>`;
                });
                const joinedLinks = htmlLinks.join(', ');
                const result = (type === 'eqref') ? `(${joinedLinks})` : joinedLinks;
                return renderer.protectHtml('ref', result);
            });
            return text;
        }
    },

    {
        name: 'citations',
        priority: 70,
        apply: (text, renderer: RenderContext) => {
            text = text.replace(R_CITATION, (_match, cmd, opt1, opt2, keys) => {
                const keyArray = splitLatexCitationKeys(keys);
                let pre = '';
                let post = '';
                if (opt2 !== undefined) { pre = opt1 ? opt1 + ' ' : ''; post = opt2; }
                else if (opt1 !== undefined) { post = opt1; }
                const safePre = escapeHtml(pre);
                const safePost = escapeHtml(post);

                const parts: CitationPart[] = keyArray.map((key: string) => {
                    renderer.resolveCitation(key);
                    const entry = renderer.bibEntries.get(key);
                    if (!entry) { return { error: true, key, author: "unknown", year: "unknown" }; }
                    const author = BibTexParser.getShortAuthor(entry);
                    const year = escapeHtml(entry.fields.year || "unknown");
                    return { error: false, key, author, year };
                });

                const mkLink = (text: string, key: string) => {
                    const safeKey = escapeHtmlAttribute(key);
                    return `<a href="#ref-${safeKey}" class="latex-cite-link" style="color:#2e7d32; text-decoration:none;">${text}</a>`;
                };
                const renderYearText = (part: CitationPart, isLast: boolean) => {
                    if (part.error) { return `[${escapeHtml(part.key)}?]`; }
                    const suffix = isLast && safePost ? `, ${safePost}` : '';
                    return mkLink(`${part.year}${suffix}`, part.key);
                };

                let finalHtml = "";
                if (cmd === 'citet') {
                    const formatted = parts.map((part, i) => {
                        const isLast = i === parts.length - 1;
                        if (part.error) { return renderYearText(part, isLast); }
                        return `${part.author} (${renderYearText(part, isLast)})`;
                    }).join(', ');
                    finalHtml = safePre + formatted;
                } else if (cmd === 'citeyear') {
                    const formatted = parts.map((part, i) => renderYearText(part, i === parts.length - 1)).join(', ');
                    finalHtml = safePre + formatted;
                } else {
                    const inner = parts.map((part) => {
                        if (part.error) { return `[${escapeHtml(part.key)}?]`; }
                        return mkLink(`${part.author}, ${part.year}`, part.key);
                    }).join('; ');
                    let content = inner;
                    if (safePre) { content = safePre + content; }
                    if (safePost) { content = content + ', ' + safePost; }
                    finalHtml = `(${content})`;
                }

                return renderer.protectHtml('cite', finalHtml);
            });
            return text;
        }
    },

    {
        name: 'bibliography',
        priority: 71,
        apply: (text, renderer: RenderContext) => {
            text = text.replace(R_BIBLIOGRAPHY_STYLE, '');
            text = text.replace(new RegExp(R_THEBIBLIOGRAPHY, 'gi'), (_match, content) => {
                const entries = Array.from(BibTexParser.parseBibItems(content).values());
                return entries.length
                    ? renderBibliographyItems(entries.map(entry => ({ key: entry.key, entry })), renderer)
                    : '';
            });
            return text.replace(new RegExp(R_BIBLIOGRAPHY, 'g'), () => {
                const citedKeys = renderer.getCitedKeys();
                if (citedKeys.length === 0) {
                    return renderer.protectHtml('bib', `<div class="latex-bibliography error">No citations found.</div>`);
                }
                const sortedKeys = Array.from(new Set(citedKeys)).sort((a, b) => {
                    const entryA = renderer.bibEntries.get(a);
                    const entryB = renderer.bibEntries.get(b);
                    const authA = entryA ? (entryA.fields.author || '') : '';
                    const authB = entryB ? (entryB.fields.author || '') : '';
                    return authA.localeCompare(authB);
                });

                return renderBibliographyItems(sortedKeys.map(key => ({ key, entry: renderer.bibEntries.get(key) })), renderer);
            });
        }
    },

    {
        name: 'escaped_chars2',
        priority: 90,
        apply: (text, renderer: RenderContext) => {
            return text.replace(/\\([%#&])/g, (_match, char) => {
                const entity = char === '&' ? '&amp;' : char === '#' ? '&#35;' : '&#37;';
                return renderer.protectHtml('raw', entity);
            });
        }
    },

    {
        name: 'latex_quotes',
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
        name: 'latex_special_spaces',
        priority: 119,
        apply: (text, renderer: RenderContext) => {
            return text.replace(/~/g, () => renderer.protectHtml('space', '&nbsp;'));
        }
    },

    {
        name: 'latex_links',
        priority: 115,
        apply: (text, renderer: RenderContext) => replaceLatexLinkCommands(text, renderer)
    },

    createFigureRule(),
    createAlgorithmRule(),
    createTableRule(),

    {
        name: 'theorems_and_proofs',
        priority: 150,
        apply: (text, renderer: RenderContext) => {
            const thmRegex = new RegExp(`\\\\begin\\{(${REGEX_STR.THEOREM_ENVS})\\}(?:\\{.*?\\})?(?:\\[(.*?)\\])?([\\s\\S]*?)\\\\end\\{\\1\\}`, 'gi');

            text = text.replace(thmRegex, (_match, envName, optArg, content) => {
                const displayName = getTheoremDisplayName(envName);

                let header = `<span class="latex-thm-head"><strong class="latex-theorem-header">${displayName} <span class="sn-cnt" data-type="thm"></span>`;

                if (optArg) {
                    header += `</strong>&nbsp;(${escapeHtml(optArg)}).</span>&nbsp; `;
                } else {
                    header += `.</strong></span>&nbsp; `;
                }

                let body = resolveLatexStyles(content.trim(), protectInlineStyle(renderer));
                body = escapeHtml(body);
                return `\n\n${renderer.protectHtml('thm', `<div class="latex-theorem">${header}${body}</div>`)}\n\n`;
            });

            text = text.replace(/\\begin\{proof\}(?:\[(.*?)\])?/gi, (_match, optArg) => {
                const title = optArg ? `Proof (${escapeHtml(optArg)}).` : `Proof.`;
                return `\n${renderer.protectHtml('raw', '<span class="no-indent-marker"></span>')}**${title}** `;
            });
            return text.replace(/\\end\{proof\}/gi, () => ` ${renderer.protectHtml('raw', '<span style="float:right;">QED</span>')}\n`);
        }
    },

    {
        name: 'maketitle_and_abstract',
        priority: 160,
        apply: (text, renderer: RenderContext) => {
            if (text.includes('\\maketitle')) {
                let titleBlock = '';
                const metadata = renderer.metadata;
                const processMeta = (value: string | undefined) => renderMetadataValue(value, renderer);

                const safeTitle = processMeta(metadata?.title);
                const safeAuthors = renderMaketitleAuthors(
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

            const keywordsRegex = /(?:\\begin\{keywords?\}([\s\S]*?)\\end\{keywords?\}|\\noindent\{\\bf Keywords\}:\s*(.*))/gi;
            text = text.replace(keywordsRegex, (_match, contentA, contentB) => keywordsSentinel(contentA || contentB || ''));

            return text;
        }
    },

    {
        name: 'sections',
        priority: 170,
        apply: (text, renderer: RenderContext) => {
            const sectionRegex = new RegExp(`\\\\(${REGEX_STR.SECTION_LEVELS})(\\*?)\\{((?:[^{}]|{[^{}]*})*)\\}\\s*(\\\\label\\{[^}]+\\})?\\s*`, 'g');

            return text.replace(sectionRegex, (_match, level, star, content, label) => {
                let prefix = '##';
                if (level === 'subsection') { prefix = '###'; }
                else if (level === 'subsubsection') { prefix = '####'; }
                else if (level === 'paragraph') { prefix = '#####'; }
                else if (level === 'subparagraph') { prefix = '######'; }

                let numHtml = "";
                if (star !== '*' && !['paragraph', 'subparagraph'].includes(level)) {
                    numHtml = `<span class="sn-cnt" data-type="sec"></span>. `;
                }

                let anchor = "";
                if (label) {
                    const labelName = label.match(/\{([^}]+)\}/)?.[1] || "";
                    anchor = createHiddenLabelAnchor(labelName);
                }
                if(anchor) {anchor = renderer.protectHtml('anchor', anchor);}
                if(numHtml) {numHtml = renderer.protectHtml('secnum', numHtml);}

                return `\n${prefix} ${numHtml}${content.trim()} ${anchor}\n`;
            });
        }
    },

    {
        name: 'lists',
        priority: 180,
        apply: (text) => {
            const listStack: string[] = [];
            return text.replace(/(\\begin\{(?:itemize|enumerate)\})|(\\end\{(?:itemize|enumerate)\})|(\\item(?:\[(.*?)\])?)/g, (match, pBegin, pEnd, pItem, pLabel) => {
                if (pBegin) {
                    listStack.push(match.includes('itemize') ? 'ul' : 'ol');
                    return '\n\n';
                } else if (pEnd) {
                    listStack.pop();
                    return '\n\n';
                } else if (pItem) {
                    const depth = listStack.length;
                    const indent = '  '.repeat(Math.max(0, depth - 1));
                    const currentType = listStack[listStack.length - 1] || 'ul';
                    if (pLabel) { return `\n${indent}- **${pLabel}** `; }
                    return `\n${indent}${currentType === 'ul' ? '-' : '1.'} `;
                }
                return match;
            });
        }
    },

    {
        name: 'text_styles',
        priority: 190,
        apply: (text, renderer: RenderContext) => {
            return resolveLatexStyles(text, protectInlineStyle(renderer));
        }
    }
];

export const DEFAULT_BLOCK_DEPENDENCY_RULES: BlockDependencyRule[] = [
    defineBlockDependencyRule({
        name: 'maketitle',
        collect: ({ text, deps }) => {
            if (!text.includes('\\maketitle')) { return []; }
            return [
                deps.metadata('title'),
                deps.metadata('date'),
                deps.metadata('authors'),
                deps.metadata('affiliations'),
                deps.metadata('custom.editor')
            ];
        }
    }),
    defineBlockDependencyRule({
        name: 'bibliography',
        collect: ({ text, deps }) => {
            if (!R_BIBLIOGRAPHY.test(text)) { return []; }
            return [deps.citedKeys()];
        }
    })
];

export const SNAP_TEX_RULES = defineRuleRegistry({
    metadataExtractors: [
        BUILTIN_METADATA_EXTRACTOR,
        EDITOR_METADATA_EXTRACTOR
    ],
    renderRules: DEFAULT_RENDER_RULES,
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
