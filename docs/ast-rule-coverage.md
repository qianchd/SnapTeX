# AST Rule Coverage

This table tracks how the experimental AST backend maps to the mature legacy
rendering path. It is meant to guide parity work without turning AST mode into a
second copy of the regex rule pipeline.

| Feature | Legacy path | AST path | Current status |
| --- | --- | --- | --- |
| Sections | `sections` render rule | `ast-section` | Covered, including starred headings and inline math titles. |
| Labels, refs, eqrefs | `refs_and_labels` | `ast-label`, `ast-ref` | Covered, including starred refs. Number text still comes from `LatexCounterScanner`. |
| Citations | `citations` | `ast-citation` | Covered for common natbib-style commands and optional arguments. |
| Inline/display math | `inline_math`, `display_math` | `ast-math` | Covered with preamble macros; AST source hints refine sync inside math-heavy blocks. |
| Text styles and color | `text_styles` plus splitter protection | `ast-text-style` plus span prefix/suffix | Covered for block and inline style scopes. Long decorator groups are refined by the AST splitter. |
| Lists | `lists` | `ast-list` | Covered for itemize/enumerate and common label templates. |
| Theorem/proof-like environments | `theorems_and_proofs` | `ast-theorem`, `ast-proof` | Covered, including nested lists/tables after splitter refinement. |
| Tables and tabular variants | table helpers called by legacy float rules | `ast-float`, `ast-tabular`, `ast-table-macro` | Broad preview support for tabular, tabularx, tabular*, multicolumn, multirow, makecell, tnote, and tablenotes. Not a full LaTeX table engine. |
| Algorithms | legacy algorithm rendering in `rules.ts` | AST float/list/text rules | Covered for algorithm/algorithmic wrappers and common `\REQUIRE`, `\STATE`, `\FOR`, `\IF` commands. |
| TikZ | legacy TikZ placeholder rules | `ast-tikz` inside `ast-float` | Covered by emitting the same TikZJax placeholder contract as legacy. |
| Graphics and PDF | `renderIncludeGraphicsHtml` | `ast-includegraphics` | Covered; preview runtime still lazily requests resources. |
| Bibliography | `bibliography` render rule and bib parser | `ast-bibliography` | Covered for external `.bib` and inline `thebibliography` entries. |
| Maketitle, abstract, keywords | `maketitle_and_abstract` | `ast-maketitle`, `ast-abstract-keywords` | Covered for structured title-page metadata and journal-style commands. |
| Common layout/text macros | `clean_layout_cmds`, `mbox`, spacing rules | `ast-common-macro` and shared inline rendering | Partially covered. Unsupported template macros should remain source-preserving instead of silently disappearing. |

## Rule Ownership

* `src/rules.ts` remains the public registry entry point for both legacy and AST
  rules.
* `RuleRegistry.astRenderRules` is the AST rendering extension point.
* Splitter behavior that affects rule visibility belongs to `splitterRules`,
  not inside individual render rules.
* Numbering stays with `LatexCounterScanner` for now; AST rules should render
  around the numbering payload rather than computing their own counters.

