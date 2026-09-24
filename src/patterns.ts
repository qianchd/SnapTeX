/**
 * Shared LaTeX environment lists and regex fragments.
 *
 * Splitter, scanner, and render rules all consume these constants so supported
 * environments remain aligned across parsing and rendering.
 */

export const MATH_ENVS = [
    'equation', 'align', 'gather', 'multline', 'flalign', 'alignat', 'eqnarray', 'IEEEeqnarray',
    'mini', 'maxi', 'minie', 'maxie', 'mini!', 'maxi!'
];

const FLOAT_ENVS = [
    'figure', 'table', 'longtable', 'algorithm'
];

const THEOREM_ENV_GROUPS = [
    ['Theorem', ['theorem', 'thm']],
    ['Proposition', ['proposition', 'prop', 'pro']],
    ['Lemma', ['lemma', 'lem']],
    ['Definition', ['definition', 'def', 'defi', 'defn']],
    ['Condition', ['condition', 'cond', 'con']],
    ['Assumption', ['assumption', 'assum', 'assu', 'assump']],
    ['Hypothesis', ['hypothesis']],
    ['Remark', ['remark', 'remarks', 'rem', 'rmk']],
    ['Corollary', ['corollary', 'cor', 'coro']],
    ['Example', ['example', 'ex']],
    ['Fact', ['fact']],
    ['Claim', ['claim']],
    ['Conjecture', ['conjecture', 'conj']],
    ['Question', ['question']],
    ['Observation', ['observation']],
    ['Problem', ['problem']],
    ['Principle', ['principle']],
    ['Property', ['property']],
    ['Result', ['result']]
] as const;

export const THEOREM_ENVS = THEOREM_ENV_GROUPS.flatMap(([displayName, envs]) => [...envs, displayName]);
const THEOREM_DISPLAY_NAMES = new Map<string, string>(
    THEOREM_ENV_GROUPS.flatMap(([displayName, envs]) => envs.map(envName => [envName, displayName]))
);

export const SECTION_LEVELS = [
    'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'
] as const;

export const TIKZ_GLOBAL_COMMANDS = [
    'usetikzlibrary', 'tikzset', 'definecolor', 'pgfkeys', 'pgfdeclareshape'
];

const PREAMBLE_DEFINITION_COMMANDS = [
    ...TIKZ_GLOBAL_COMMANDS, 'newcommand', 'renewcommand', 'providecommand', 'algnewcommand',
    'DeclareMathOperator', 'DeclarePairedDelimiter', 'DeclarePairedDelimiterX',
    'newtheorem', 'newenvironment', 'renewenvironment', 'newcolumntype',
    'newtcolorbox', 'renewtcolorbox', 'providetcolorbox', 'newlength', 'gdef', 'def'
];

export const CITATION_COMMANDS = [
    'cite', 'citep', 'citet', 'citealp', 'citealt', 'citeyear', 'citeyearpar', 'citeauthor', 'citenum',
    'parencite', 'textcite', 'autocite', 'footcite', 'smartcite'
] as const;

export const REFERENCE_COMMANDS = ['ref', 'eqref', 'cref', 'Cref', 'subref', 'vref', 'Vref', 'autoref'] as const;

export const LATEX_LAYOUT_BREAK_COMMANDS = [
    'par', 'smallskip', 'medskip', 'bigskip', 'linebreak', 'newline',
    'newpage', 'clearpage', 'pagebreak', 'vfill', 'newblock'
] as const;

export const LATEX_UNBRACED_SPACING_COMMANDS = ['vskip', 'hskip', 'kern'] as const;
export const LATEX_DIMENSION_SOURCE = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)[ \t]*(?:true[ \t]*)?(?:pt|pc|in|bp|cm|mm|dd|cc|sp|em|ex|mu)\b`;

export const LATEX_FONT_SIZE_COMMANDS = [
    'tiny', 'scriptsize', 'footnotesize', 'small', 'normalsize', 'large', 'Large', 'LARGE', 'huge', 'Huge'
] as const;

export const LATEX_PREVIEW_NOOP_COMMANDS = [
    'nolinebreak', 'nobreak', 'unskip', 'phantomsection', 'balance', 'nolinenumbers',
    'frontmatter', 'mainmatter', 'backmatter'
] as const;

export const LATEX_LAYOUT_SWITCH_COMMANDS = [
    'centering', 'raggedright', 'raggedleft', 'hfill', 'nopagebreak', 'sloppy',
    'allowdisplaybreaks', 'raggedbottom', 'flushbottom', 'doublespacing', 'selectfont',
    'quad', 'qquad', 'allowbreak', ...LATEX_PREVIEW_NOOP_COMMANDS, ...LATEX_FONT_SIZE_COMMANDS
] as const;

export const LATEX_OMITTED_ARGUMENT_COMMANDS = {
    vspace: 1,
    hspace: 1,
    fontsize: 2,
    enlargethispage: 1,
    setlength: 2,
    addtolength: 2,
    addvspace: 1,
    setcounter: 2,
    addtocounter: 2,
    counterwithin: 2,
    numberwithin: 2,
    thispagestyle: 1,
    pagestyle: 1,
    pagenumbering: 1,
    crefalias: 2,
    subjclass: 1,
    captionsetup: 1,
    titleformat: 5,
    titlespacing: 4,
    addcontentsline: 3,
    rule: 2,
    setstretch: 1,
    Needspace: 1,
    noalign: 1,
    shorttitle: 1,
    shortauthors: 1,
    articletype: 1,
    authormark: 1,
    credit: 1,
    pacs: 1
} as const;

export const LATEX_PREVIEW_OMITTED_COMMANDS = [
    'begingroup', 'endgroup', 'tableofcontents', 'FloatBarrier', 'addlinespace', 'qedhere', 'footnotemark',
    'iftrue', 'iffalse', 'else', 'fi', 'leavevmode', 'protect', 'relax', 'ignorespaces', 'ignorespacesafterend', 'qed',
    'makeatletter', 'makeatother', 'cormark', 'fnmark', 'printcredits', 'IEEEpeerreviewmaketitle',
    'SetAlgoLined'
] as const;

export const LATEX_INLINE_NOTE_COMMANDS = ['footnote', 'footnotetext', 'thanks', 'cortext', 'fntext'] as const;

export const LATEX_TEXT_ACCENTS = {
    "'": '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303', '=': '\u0304', '.': '\u0307',
    u: '\u0306', v: '\u030C', H: '\u030B', c: '\u0327', d: '\u0323', b: '\u0331', r: '\u030A', k: '\u0328'
} as const;

export const SUBCAPTIONBOX_ARGUMENT_ORDER = [
    { delimiter: 'brace' },
    { delimiter: 'bracket', optional: true },
    { delimiter: 'brace' }
] as const;

export const SUBFIGURE_MACRO_COMMANDS = ['subfloat', 'subfigure'] as const;

export interface LatexContentWrapperSpec {
    requiredArgs: number;
    contentArg: number;
    optionalArgs?: number;
    argumentOrder?: readonly { delimiter: 'brace' | 'bracket'; optional?: boolean }[];
    prefix?: string;
    suffix?: string;
}

/** Formatting-only macros whose visible preview is one of their required arguments. */
export const LATEX_CONTENT_WRAPPER_COMMANDS: Readonly<Record<string, LatexContentWrapperSpec>> = {
    mbox: { requiredArgs: 1, contentArg: 0 },
    text: { requiredArgs: 1, contentArg: 0 },
    hbox: { requiredArgs: 1, contentArg: 0 },
    makebox: { requiredArgs: 1, contentArg: 0, optionalArgs: 2 },
    framebox: { requiredArgs: 1, contentArg: 0, optionalArgs: 2 },
    fbox: { requiredArgs: 1, contentArg: 0 },
    ovalbox: { requiredArgs: 1, contentArg: 0 },
    shortstack: { requiredArgs: 1, contentArg: 0, optionalArgs: 1 },
    parbox: { requiredArgs: 2, contentArg: 1, optionalArgs: 3 },
    scalebox: { requiredArgs: 2, contentArg: 1 },
    rotatebox: { requiredArgs: 2, contentArg: 1, optionalArgs: 1 },
    raisebox: {
        requiredArgs: 2,
        contentArg: 1,
        argumentOrder: [{ delimiter: 'brace' }, { delimiter: 'bracket', optional: true }, { delimiter: 'bracket', optional: true }, { delimiter: 'brace' }]
    },
    centerline: { requiredArgs: 1, contentArg: 0 },
    name: { requiredArgs: 1, contentArg: 0 },
    addr: { requiredArgs: 1, contentArg: 0 },
    email: { requiredArgs: 1, contentArg: 0 },
    affil: { requiredArgs: 1, contentArg: 0, optionalArgs: 1 },
    colorbox: { requiredArgs: 2, contentArg: 1 },
    fcolorbox: { requiredArgs: 3, contentArg: 2 },
    resizebox: { requiredArgs: 3, contentArg: 2 },
    texorpdfstring: { requiredArgs: 2, contentArg: 0 },
    hyperlink: { requiredArgs: 2, contentArg: 1 },
    hypertarget: { requiredArgs: 2, contentArg: 1 },
    'Hy@raisedlink@left': { requiredArgs: 1, contentArg: 0 },
    enquote: { requiredArgs: 1, contentArg: 0, optionalArgs: 1, prefix: '“', suffix: '”' }
};

export const LATEX_DECLARATION_STYLE_COMMANDS = [
    'bf', 'bfseries', 'it', 'itshape', 'em', 'slshape', 'scshape',
    'sf', 'sffamily', 'rm', 'rmfamily', 'tt', 'ttfamily', 'upshape', 'normalfont'
] as const;

export const TRANSPARENT_CONTAINER_ENVIRONMENTS = [
    'appendix', 'appendices', 'samepage', 'sloppypar', 'frontmatter', 'subequations', 'landscape', 'NoHyper',
    'singlespace', 'onehalfspace', 'doublespace', ...LATEX_FONT_SIZE_COMMANDS
] as const;

const LIST_ENV_GROUPS = [
    ['ul', ['itemize', 'list', 'compactitem', 'description', 'compactdesc', 'highlights']],
    ['ol', ['enumerate', 'compactenum']]
] as const;

const LIST_ENVS = LIST_ENV_GROUPS.flatMap(([, envs]) => envs);
const LIST_TAG_NAMES = new Map<string, 'ul' | 'ol'>(
    LIST_ENV_GROUPS.flatMap(([tagName, envs]) => envs.map(envName => [envName, tagName]))
);

export const PROOF_ENVS = ['proof', 'IEEEproof'];
export const ACKNOWLEDGMENT_ENVS = ['acks', 'acknowledgments', 'acknowledgements'];
export const QUOTE_ENVS = ['quote', 'quotation'];

const join = (arr: readonly string[]) => arr.join('|');

export function getTheoremDisplayName(envName: string): string {
    const rawName = envName.toLowerCase();
    return THEOREM_DISPLAY_NAMES.get(rawName) ?? rawName.charAt(0).toUpperCase() + rawName.slice(1);
}

export function getListTagName(envName: string): 'ul' | 'ol' | undefined {
    return LIST_TAG_NAMES.get(envName);
}

export const REGEX_STR = {
    MATH_ENVS: join(MATH_ENVS),
    FLOAT_ENVS: join(FLOAT_ENVS),
    THEOREM_ENVS: join(THEOREM_ENVS),
    LIST_ENVS: join(LIST_ENVS),
    PROOF_ENVS: join(PROOF_ENVS),
    ACKNOWLEDGMENT_ENVS: join(ACKNOWLEDGMENT_ENVS),
    QUOTE_ENVS: join(QUOTE_ENVS),
    SECTION_LEVELS: join(SECTION_LEVELS),
    CITATION_CMDS: join(CITATION_COMMANDS),
    PREAMBLE_DEFINITIONS: join(PREAMBLE_DEFINITION_COMMANDS)
};

export const R_REF = new RegExp(`\\\\(${REFERENCE_COMMANDS.join('|')})\\*?\\{([^}]+)\\}`, 'g');

export const R_BIBLIOGRAPHY = /\\bibliography\{([^}]+)\}/;

export const R_ADDBIBRESOURCE = /\\addbibresource(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/;

export const R_PRINTBIBLIOGRAPHY = /\\printbibliography(?:\s*\[[^\]]*\])?/;

export const R_THEBIBLIOGRAPHY = /\\begin\{thebibliography\}(?:\{[^}]*\})?([\s\S]*?)\\end\{thebibliography\}/i;

export const R_BIBLIOGRAPHY_STYLE = /\\bibliographystyle\{[^}]+\}/g;

export const R_CITATION = new RegExp(`\\\\(${REGEX_STR.CITATION_CMDS})(?:\\*?)(?:\\s*\\[([^\\]]*)\\])?(?:\\s*\\[([^\\]]*)\\])?\\s*\\{([^}]+)\\}`, 'g');
