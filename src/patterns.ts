/**
 * Shared LaTeX environment lists and regex fragments.
 *
 * Splitter, scanner, and render rules all consume these constants so supported
 * environments remain aligned across parsing and rendering.
 */

const MATH_ENVS = [
    'equation', 'align', 'gather', 'multline', 'flalign', 'alignat'
];

const FLOAT_ENVS = [
    'figure', 'table', 'algorithm'
];

const THEOREM_ENV_GROUPS = [
    ['Theorem', ['theorem', 'thm']],
    ['Proposition', ['proposition', 'prop']],
    ['Lemma', ['lemma', 'lem']],
    ['Definition', ['definition', 'def', 'defi']],
    ['Condition', ['condition', 'cond']],
    ['Assumption', ['assumption', 'assum', 'assu']],
    ['Remark', ['remark', 'rem', 'rmk']],
    ['Corollary', ['corollary', 'cor', 'coro']],
    ['Example', ['example', 'ex']]
] as const;

const THEOREM_ENVS = THEOREM_ENV_GROUPS.flatMap(([, envs]) => envs);
const THEOREM_DISPLAY_NAMES = new Map<string, string>(
    THEOREM_ENV_GROUPS.flatMap(([displayName, envs]) => envs.map(envName => [envName, displayName]))
);

const SECTION_LEVELS = [
    'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'
] as const;

const CITATION_CMDS = [
    'cite', 'citep', 'citet', 'citeyear'
];

const SPLITTER_IGNORED_ENVS = [
    'proof'
];

const SPLITTER_MAJOR_ENVS = [
    ...MATH_ENVS,
    ...FLOAT_ENVS,
    ...THEOREM_ENVS
];

const join = (arr: readonly string[]) => arr.join('|');

export function getTheoremDisplayName(envName: string): string {
    const rawName = envName.toLowerCase();
    return THEOREM_DISPLAY_NAMES.get(rawName) ?? rawName.charAt(0).toUpperCase() + rawName.slice(1);
}

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

export const R_THEBIBLIOGRAPHY = /\\begin\{thebibliography\}(?:\{[^}]*\})?([\s\S]*?)\\end\{thebibliography\}/i;

export const R_BIBLIOGRAPHY_STYLE = /\\bibliographystyle\{[^}]+\}/g;

export const R_CITATION = new RegExp(`\\\\(${REGEX_STR.CITATION_CMDS})(?:\\*?)(?:\\s*\\[([^\\]]*)\\])?(?:\\s*\\[([^\\]]*)\\])?\\s*\\{([^}]+)\\}`, 'g');
