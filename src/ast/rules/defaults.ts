import { AST_CITATION_RULE } from './citations';
import { AST_ABSTRACT_KEYWORDS_RULE, AST_BIBLIOGRAPHY_RULE, AST_COMMON_MACRO_RULE, AST_LINK_RULE, AST_MAKETITLE_RULE } from './document';
import { AST_FLOAT_RULE, AST_SUBFIGURE_RULE, AST_TABLE_MACRO_RULE, AST_TABULAR_RULE } from './floats';
import { AST_INCLUDEGRAPHICS_RULE } from './graphics';
import { AST_LABEL_RULE } from './labels';
import { AST_LIST_RULE } from './lists';
import { AST_MATH_RULE } from './math';
import { AST_REF_RULE } from './refs';
import type { AstRenderRule } from './index';
import { AST_SECTION_RULE } from './sections';
import { AST_TEXT_STYLE_RULE } from './styles';
import { AST_PROOF_BOUNDARY_RULE, AST_PROOF_RULE, AST_THEOREM_RULE } from './theorems';
import { AST_TIKZ_RULE } from './tikz';

export const DEFAULT_AST_RENDER_RULES: readonly AstRenderRule[] = [
    AST_TEXT_STYLE_RULE,
    AST_MATH_RULE,
    AST_MAKETITLE_RULE,
    AST_ABSTRACT_KEYWORDS_RULE,
    AST_BIBLIOGRAPHY_RULE,
    AST_LINK_RULE,
    AST_SECTION_RULE,
    AST_FLOAT_RULE,
    AST_SUBFIGURE_RULE,
    AST_PROOF_BOUNDARY_RULE,
    AST_THEOREM_RULE,
    AST_PROOF_RULE,
    AST_LIST_RULE,
    AST_TIKZ_RULE,
    AST_TABULAR_RULE,
    AST_TABLE_MACRO_RULE,
    AST_INCLUDEGRAPHICS_RULE,
    AST_LABEL_RULE,
    AST_REF_RULE,
    AST_CITATION_RULE,
    AST_COMMON_MACRO_RULE
];
