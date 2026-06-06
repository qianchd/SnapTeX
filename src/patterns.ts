/**
 * Shared LaTeX environment lists and regex fragments.
 *
 * Splitter, scanner, and render rules all consume these constants so supported
 * environments remain aligned across parsing and rendering.
 */

export const MATH_ENVS = [
    'equation', 'align', 'gather', 'multline', 'flalign', 'alignat'
];

export const FLOAT_ENVS = [
    'figure', 'table', 'algorithm'
];

export const THEOREM_ENVS = [
    'theorem', 'thm',
    'proposition', 'prop',
    'lemma', 'lem',
    'definition', 'def', 'defi',
    'condition', 'cond',
    'assumption', 'assum', 'assu',
    'remark', 'rem', 'rmk',
    'corollary', 'cor', 'coro',
    'example', 'ex'
];
export const SECTION_LEVELS = [
    'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'
];

export const CITATION_CMDS = [
    'cite', 'citep', 'citet', 'citeyear'
];

export const SPLITTER_IGNORED_ENVS = [
    'proof', 'itemize', 'enumerate'
];

export const SPLITTER_MAJOR_ENVS = [
    ...MATH_ENVS,
    ...FLOAT_ENVS,
    ...THEOREM_ENVS,
    'thm', 'prop',
    'tikzpicture'
];

const join = (arr: string[]) => arr.join('|');

export const REGEX_STR = {
    MATH_ENVS: join(MATH_ENVS),
    FLOAT_ENVS: join(FLOAT_ENVS),
    THEOREM_ENVS: join(THEOREM_ENVS),
    SECTION_LEVELS: join(SECTION_LEVELS),
    CITATION_CMDS: join(CITATION_CMDS),
    SPLITTER_IGNORED: join(SPLITTER_IGNORED_ENVS),
    SPLITTER_MAJOR: join(SPLITTER_MAJOR_ENVS)
};

export const R_LABEL = /\\label\s*\{([^}]+)\}/;

export const R_REF = /\\(ref|eqref)\*?\{([^}]+)\}/g;

export const R_BIBLIOGRAPHY = /\\bibliography\{([^}]+)\}/;

export const R_BIBLIOGRAPHY_STYLE = /\\bibliographystyle\{[^}]+\}/g;

export const R_CITATION = new RegExp(`\\\\(${REGEX_STR.CITATION_CMDS})(?:\\*?)(?:\\s*\\[([^\\]]*)\\])?(?:\\s*\\[([^\\]]*)\\])?\\s*\\{([^}]+)\\}`, 'g');
