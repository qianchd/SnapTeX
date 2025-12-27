/**
 * src/patterns.ts
 * Centralized location for LaTeX regex patterns and environment lists.
 */

// --- Lists of Environment Names ---

export const MATH_ENVS = [
    'equation', 'align', 'gather', 'multline', 'flalign', 'alignat'
];

export const FLOAT_ENVS = [
    'figure', 'table', 'algorithm'
];

export const THEOREM_ENVS = [
    'theorem', 'lemma', 'proposition', 'condition', 'condbis',
    'assumption', 'remark', 'definition', 'corollary', 'example'
];

// Note: Section levels usually map to specific logic, but good to have listed.
export const SECTION_LEVELS = [
    'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'
];

export const CITATION_CMDS = [
    'cite', 'citep', 'citet', 'citeyear'
];

// Environments ignored by the splitter (internal content structure, allow split inside)
export const SPLITTER_IGNORED_ENVS = [
    'proof', 'itemize', 'enumerate', 'tikzpicture'
];

// Major environments for splitter logic (usually don't split inside unless trapped)
// Note: This list in splitter.ts was slightly different (included short names like 'thm', 'prop').
// We preserve the original logic's coverage.
export const SPLITTER_MAJOR_ENVS = [
    ...MATH_ENVS,
    ...FLOAT_ENVS,
    ...THEOREM_ENVS,
    'thm', 'prop' // Short aliases sometimes used
];

// --- Helper for Regex Construction ---
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

// --- Common Regexes ---

// Matches: \label{key}
export const R_LABEL = /\\label\{([^}]+)\}/;

// Matches: \ref{key} or \eqref{key}
export const R_REF = /\\(ref|eqref)\*?\{([^}]+)\}/g;

// Matches: \bibliography{file}
export const R_BIBLIOGRAPHY = /\\bibliography\{([^}]+)\}/;

// Matches: \cite[opt]{key} etc.
// Captures: 1=cmd, 2=opt1, 3=opt2, 4=keys
export const R_CITATION = new RegExp(`\\\\(${REGEX_STR.CITATION_CMDS})(?:\\*?)(?:\\s*\\[([^\\]]*)\\])?(?:\\s*\\[([^\\]]*)\\])?\\s*\\{([^}]+)\\}`, 'g');