import {
    toRoman,
    capitalizeFirstLetter,
    createHiddenLabelAnchor,
    escapeHtml,
    escapeHtmlAttribute,
    extractAndHideLabels,
    findBalancedClosingBrace,
    resolveLatexStyles,
    sanitizeHttpUrlForAttribute
} from './utils';
import { PreprocessRule, RenderContext } from './types';
import { BibTexParser } from './bib';
import { REGEX_STR, R_LABEL, R_REF, R_CITATION, R_BIBLIOGRAPHY } from './patterns';
import { createRefLink, renderMath } from './rule-helpers';
import { createTikzPictureRule } from './rule-tikz';
import { createAlgorithmRule, createFigureRule, createTableRule } from './rule-floats';

interface BraceArgument {
    content: string;
    end: number;
}

function readBraceArgument(text: string, start: number): BraceArgument | undefined {
    const openMatch = /^\s*\{/.exec(text.slice(start));
    if (!openMatch) {
        return undefined;
    }

    const openIndex = start + openMatch[0].length - 1;
    const closeIndex = findBalancedClosingBrace(text, openIndex);
    if (closeIndex === -1) {
        return undefined;
    }

    return {
        content: text.slice(openIndex + 1, closeIndex),
        end: closeIndex + 1
    };
}

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

function renderHrefCommand(rawUrl: string, rawContent: string, renderer: RenderContext): string {
    const styledContent = resolveLatexStyles(rawContent, html => renderer.protectHtml('style', html));
    return renderExternalLink(rawUrl, escapeHtml(styledContent), 'latex-href', renderer);
}

function renderUrlCommand(rawUrl: string, renderer: RenderContext): string {
    return renderExternalLink(rawUrl, escapeHtml(rawUrl.trim()), 'latex-url', renderer);
}

function replaceLatexLinkCommands(text: string, renderer: RenderContext): string {
    const commandRegex = /\\(href|url)\s*\{/g;
    let output = "";
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = commandRegex.exec(text)) !== null) {
        const commandName = match[1];
        const commandStart = match.index;
        const urlArgument = readBraceArgument(text, commandRegex.lastIndex - 1);
        if (!urlArgument) {
            continue;
        }

        let replacement: string;
        let commandEnd = urlArgument.end;
        if (commandName === 'href') {
            const contentArgument = readBraceArgument(text, urlArgument.end);
            if (!contentArgument) {
                continue;
            }
            replacement = renderHrefCommand(urlArgument.content, contentArgument.content, renderer);
            commandEnd = contentArgument.end;
        } else {
            replacement = renderUrlCommand(urlArgument.content, renderer);
        }

        output += text.slice(cursor, commandStart);
        output += replacement;
        cursor = commandEnd;
        commandRegex.lastIndex = cursor;
    }

    return output + text.slice(cursor);
}

/**
 * Ordered LaTeX-to-Markdown preprocessing pipeline.
 *
 * Rules consume small LaTeX constructs before Markdown-it runs. Any generated
 * HTML must go through RenderContext.protectHtml so Markdown-it cannot escape
 * or expose it as user-visible text.
 */
export const DEFAULT_PREPROCESS_RULES: PreprocessRule[] = [
    {
        name: 'clean_comments',
        priority: 5,
        apply: (text, renderer: RenderContext) => {
            return text
                .replace(/^[ \t]*%.*(?:\r?\n|$)/gm, '')
                .replace(/(?<!\\)%.*(\r?\n)?/g, '');
        }
    },

    createTikzPictureRule(),

    {
        name: 'escaped_char_dollar',
        priority: 10,
        apply: (text, renderer: RenderContext) => {
            return text.replace(/\\([$])/g, (match, char) => {
                const entities: Record<string, string> = { '$': '&#36;' };
                return renderer.protectHtml('raw', entities[char] || char);
            });
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
        apply: (text, renderer: RenderContext) => {
            return text.replace(/\\mbox/g, '\\text');
        }
    },

    {
        name: 'romannumeral',
        priority: 30,
        apply: (text, renderer: RenderContext) => {
            text = text.replace(/\\(Rmnum|rmnum|romannumeral)\s*\{?(\d+)\}?/g, (match, cmd, numStr) => {
                return toRoman(parseInt(numStr), cmd === 'Rmnum');
            });
            return text;
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

            return text.replace(mathBlockRegex, (match, m1, c1, m3, c4, m5, envName, star, c8, offset, fullString) => {
                if (offset > 0 && fullString[offset - 1] === '\\') { return match; }

                let content = c1 || c4 || c8 || match;

                let eqNumHTML = "";
                if (envName && star !== '*') {
                    eqNumHTML = `(<span class="sn-cnt" data-type="eq"></span>)`;
                }

                const { cleanContent, hiddenHtml } = extractAndHideLabels(content);
                let finalMath = cleanContent.trim();

                finalMath = finalMath.replace(/\\(ref|eqref)\*?\{([^}]+)\}/g, (m, reftype, key) => createRefLink(key, renderer, reftype as any));

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
                let safeContent = content.replace(/\\(ref|eqref)\*?\{([^}]+)\}/g, (m, reftype, key) => {
                    return createRefLink(key, renderer, reftype as any);
                });
                return renderMath(safeContent, false, renderer);
            };

            text = text.replace(/\\\(([\s\S]*?)\\\)/gm, (match, content) => processInline(content));
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
            text = text.replace(new RegExp(R_LABEL, 'g'), (match, labelName) => {
                return renderer.protectHtml('raw', createHiddenLabelAnchor(labelName));
            });

            text = text.replace(R_REF, (match, type, labels) => {
                const labelArray = labels.split(',').map((l: string) => l.trim());
                const htmlLinks = labelArray.map((label: string) => {
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
            text = text.replace(R_CITATION, (match, cmd, opt1, opt2, keys) => {
                const keyArray = keys.split(',').map((k: string) => k.trim());
                let pre = '';
                let post = '';
                if (opt2 !== undefined) { pre = opt1 ? opt1 + ' ' : ''; post = opt2; }
                else if (opt1 !== undefined) { post = opt1; }
                const safePre = escapeHtml(pre);
                const safePost = escapeHtml(post);

                const parts = keyArray.map((key: string) => {
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

                let finalHtml = "";
                if (cmd === 'citet') {
                    const formatted = parts.map((p: any, i: number) => {
                        const isLast = i === parts.length - 1;
                        if (p.error) { return `[${escapeHtml(p.key)}?]`; }
                        let yearText = p.year;
                        if (isLast && safePost) { yearText += `, ${safePost}`; }
                        return `${p.author} (${mkLink(yearText, p.key)})`;
                    }).join(', ');
                    finalHtml = safePre + formatted;
                } else if (cmd === 'citeyear') {
                    const formatted = parts.map((p: any, i: number) => {
                        const isLast = i === parts.length - 1;
                        if (p.error) { return `[${escapeHtml(p.key)}?]`; }
                        let yearText = p.year;
                        if (isLast && safePost) { yearText += `, ${safePost}`; }
                        return mkLink(yearText, p.key);
                    }).join(', ');
                    finalHtml = safePre + formatted;
                } else {
                    const inner = parts.map((p: any) => {
                        if (p.error) { return `[${escapeHtml(p.key)}?]`; }
                        return mkLink(`${p.author}, ${p.year}`, p.key);
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
            return text.replace(new RegExp(R_BIBLIOGRAPHY, 'g'), (match, file) => {
                if (renderer.citedKeys.length === 0) {
                    return renderer.protectHtml('bib', `<div class="latex-bibliography error">No citations found.</div>`);
                }
                const uniqueKeys = Array.from(new Set(renderer.citedKeys));
                const sortedKeys = uniqueKeys.sort((a, b) => {
                    const entryA = renderer.bibEntries.get(a);
                    const entryB = renderer.bibEntries.get(b);
                    const authA = entryA ? (entryA.fields.author || '') : '';
                    const authB = entryB ? (entryB.fields.author || '') : '';
                    return authA.localeCompare(authB);
                });

                let html = `<h2 class="latex-bibliography-header">References</h2><div class="latex-bibliography-list">`;
                sortedKeys.forEach((key) => {
                    const entry = renderer.bibEntries.get(key);
                    const content = entry
                        ? BibTexParser.formatEntry(entry, renderer)
                        : `<span style="color:red">Bib entry '${escapeHtml(key)}' not found.</span>`;
                    const safeKey = escapeHtmlAttribute(key);
                    html += `<div class="bib-item" id="ref-${safeKey}" style="margin-bottom: 0.8em; padding-left: 2em; text-indent: -2em;">${content}</div>`;
                });
                html += `</div>`;
                return renderer.protectHtml('bib', html);
            });
        }
    },

    {
        name: 'escaped_chars2',
        priority: 90,
        apply: (text, renderer: RenderContext) => {
            return text.replace(/\\([%#&])/g, (match, char) => {
                const entities: Record<string, string> = { '#': '&#35;', '&': '&amp;', '%': '&#37;' };
                return renderer.protectHtml('raw', entities[char] || char);
            });
        }
    },

    {
        name: 'latex_quotes',
        priority: 100,
        apply: (text, renderer: RenderContext) => {
            let processed = text.replace(/``([\s\S]*?)''/g, (match, content) => {
                const open = renderer.protectHtml('quote', '&ldquo;');
                const close = renderer.protectHtml('quote', '&rdquo;');
                return `${open}${content}${close}`;
            });
            processed = processed.replace(/`([\s\S]*?)'/g, (match, content) => {
                const open = renderer.protectHtml('quote', '&lsquo;');
                const close = renderer.protectHtml('quote', '&rsquo;');
                return `${open}${content}${close}`;
            });
            processed = processed.replace(/``/g, () => renderer.protectHtml('quote', '&ldquo;'));
            processed = processed.replace(/`/g, () => renderer.protectHtml('quote', '&lsquo;'));
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

            const DISPLAY_MAP: Record<string, string> = {
                'thm': 'Theorem',
                'prop': 'Proposition',
                'propo': 'Proposition',
                'lem': 'Lemma',
                'def': 'Definition',
                'defi': 'Definition',
                'cond': 'Condition',
                'ass': 'Assumption',
                'assu': 'Assumption',
                'cor': 'Corollary',
                'coro': 'Corollary',
                'rem': 'Remark',
                'rmk': 'Remark',
                'ex': 'Example',
                'exam': 'Example',
            };

            text = text.replace(thmRegex, (match, envName, optArg, content) => {
                const rawName = envName.toLowerCase();
                const displayName = DISPLAY_MAP[rawName] || capitalizeFirstLetter(envName);

                let header = `<span class="latex-thm-head"><strong class="latex-theorem-header">${displayName} <span class="sn-cnt" data-type="thm"></span>`;

                if (optArg) {
                    header += `</strong>&nbsp;(${escapeHtml(optArg)}).</span>&nbsp; `;
                } else {
                    header += `.</strong></span>&nbsp; `;
                }

                let body = resolveLatexStyles(content.trim(), html => renderer.protectHtml('style', html));
                body = escapeHtml(body);
                return `\n\n${renderer.protectHtml('thm', `<div class="latex-theorem">${header}${body}</div>`)}\n\n`;
            });

            text = text.replace(/\\begin\{proof\}(?:\[(.*?)\])?/gi, (match, optArg) => {
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
                const meta = renderer.currentDocument?.metadata;

                const processMeta = (val: string | undefined) => {
                    if (!val) {return '';}
                    const lineBreakToken = renderer.protectHtml('meta-br', '<br/>');
                    let res = val.replace(/<br\s*\/?>/gi, lineBreakToken);
                    res = res.replace(/\\\\/g, lineBreakToken);
                    res = res.replace(/\$((?:\\.|[^\\$])+?)\$/g, (m: string, c: string) => renderMath(c.trim(), false, renderer));
                    res = resolveLatexStyles(res, html => renderer.protectHtml('style', html));
                    res = escapeHtml(res);
                    return res;
                };

                const safeTitle = processMeta(meta?.title);
                const safeAuthor = processMeta(meta?.author);
                const safeDate = processMeta(meta?.date);

                if (safeTitle) { titleBlock += `<h1 class="latex-title">${safeTitle}</h1>`; }
                if (safeAuthor) { titleBlock += `<div class="latex-author">${safeAuthor}</div>`; }
                if (safeDate) { titleBlock += `<div class="latex-date">${safeDate}</div>`; }

                text = text.replace(/\\maketitle.*/g, `\n\n` + renderer.protectHtml('meta', titleBlock) + `\n\n`);
                text = text.replace(/ \[meta:.*?\]/g, '');
            }

            text = text.replace(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/gi, (match, content) => {
                return `\n\nOOABSTRACT_STARTOO\n\n${content.trim()}\n\nOOABSTRACT_ENDOO\n\n`;
            });

            const keywordsRegex = /(?:\\begin\{keywords?\}([\s\S]*?)\\end\{keywords?\}|\\noindent\{\\bf Keywords\}:\s*(.*))/gi;
            text = text.replace(keywordsRegex, (match, contentA, contentB) => {
                const content = (contentA || contentB || '').trim();
                return `\n\nOOKEYWORDS_STARTOO${content}OOKEYWORDS_ENDOO\n\n`;
            });

            return text;
        }
    },

    {
        name: 'sections',
        priority: 170,
        apply: (text, renderer: RenderContext) => {
            const sectionRegex = new RegExp(`\\\\(${REGEX_STR.SECTION_LEVELS})(\\*?)\\{((?:[^{}]|{[^{}]*})*)\\}\\s*(\\\\label\\{[^}]+\\})?\\s*`, 'g');

            return text.replace(sectionRegex, (match, level, star, content, label) => {
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
        apply: (text, renderer: RenderContext) => {
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
            return resolveLatexStyles(text, html => renderer.protectHtml('style', html));
        }
    }
];

export function postProcessHtml(html: string): string {
    html = html.replace(/<p>\s*OOABSTRACT_STARTOO\s*<\/p>/g, '<div class="latex-abstract"><span class="latex-abstract-title">Abstract</span>');
    html = html.replace(/OOABSTRACT_STARTOO/g, '<div class="latex-abstract"><span class="latex-abstract-title">Abstract</span>');
    html = html.replace(/<p>\s*OOABSTRACT_ENDOO\s*<\/p>/g, '</div>');
    html = html.replace(/OOABSTRACT_ENDOO/g, '</div>');
    const keywordRegex = /<p>\s*OOKEYWORDS_STARTOO([\s\S]*?)OOKEYWORDS_ENDOO\s*<\/p>/g;
    html = html.replace(keywordRegex, (match, content) => {
        return `<div class="latex-keywords"><strong>Keywords:</strong> ${content}</div>`;
    });
    return html;
}
