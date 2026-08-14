# Rendering

SnapTeX converts LaTeX source into a fast structural preview. It does not invoke a native TeX installation for ordinary content; math is rendered with KaTeX, PDFs with PDF.js, and TikZ with the bundled TikZJax runtime.

## Read support levels correctly

| Level | Meaning |
| --- | --- |
| Structural support | SnapTeX recognizes the construct and renders readable HTML with labels/navigation where applicable |
| Preview approximation | Content is preserved, but exact TeX spacing, sizing, float placement, or package styling may differ |
| Outside the preview boundary | Arbitrary package execution, class hooks, final pagination, and unsupported TeX programming require a full TeX compiler |

The sections below describe structural support. They are not package-compatibility guarantees.

## Text and structure

Supported structural constructs include:

- sections through subparagraphs;
- paragraphs, itemize, and enumerate lists;
- abstracts, keywords, title metadata, authors, affiliations, email addresses, and custom metadata;
- theorem-like environments, proofs, definitions, remarks, and conditions;
- text styles, colors, links, URLs, and common text commands.

Long style groups such as `{\color{blue} ...}` may span paragraphs and nested environments. SnapTeX preserves the style while allowing internal blocks to render independently.

## Math and macros

SnapTeX renders `$...$`, `\(...\)`, display delimiters, and common display environments such as `equation`, `align`, and `gather`. Numbered displays receive preview counters and label anchors.

The preamble scanner recognizes common macro declarations, including:

- `\newcommand` and `\renewcommand`;
- `\def`;
- `\DeclareMathOperator`;
- text macros whose replacements contain supported styles.

Macro support is intentionally bounded. Arbitrary TeX execution, package hooks, counter redefinitions, and complete TeX expansion are outside the previewer's scope.

## References and citations

`\label`, `\ref`, `\ref*`, `\eqref`, and related links resolve to preview anchors. References can jump to virtualized blocks and hover tooltips include the target block plus neighboring context when available.

Citations support common commands such as `\cite`, `\citep`, `\citet`, `\citeyear`, and `\citenum`. References may come from:

- external `.bib` files selected by `\bibliography{...}`;
- inline `thebibliography` and `\bibitem` entries.

The bibliography is a readable preview, not a complete BibTeX or natbib style implementation.

## Figures, PDFs, and subfigures

Raster and SVG images are resolved through the active host's file provider. PDF figures use PDF.js and render viewport-near pages on demand. Subfigure layouts support individual captions, labels, and per-figure letter numbering.

## Tables

The table renderer supports common `tabular`, `tabular*`, `tabularx`, `threeparttable`, and nested cell patterns. It includes practical support for:

- `booktabs` rules, including `\toprule`, `\midrule`, `\bottomrule`, and `\cmidrule`;
- `\multicolumn` and `\multirow`;
- `\makecell` and nested `tabular` cells;
- table notes and `\tnote` markers;
- math and styled text inside cells.

Column widths are adapted for the preview surface rather than reproducing TeX's exact box calculations.

## Algorithms

Algorithm and algorithmic environments render captions, labels, line numbers, indentation, and common statements such as `\REQUIRE`, `\ENSURE`, `\STATE`, `\FOR`, `\IF`, and their closing commands.

## TikZ

TikZ pictures are compiled by a bundled e-TeX/TikZJax runtime. SnapTeX:

- loads the runtime only when a rendered block contains TikZ;
- keeps the previous SVG visible while an edited picture recompiles;
- cancels stale queued renders;
- prunes unused libraries and applies preview-safe source lowering where needed;
- caches generated SVG output in IndexedDB.

TikZJax does not contain every native TeX package. Unsupported package behavior should be reduced to a small reproducible example before adding a general preview compatibility rule.

## Known boundary

SnapTeX does not promise pixel-identical output, final page breaks, floats placed by TeX, or arbitrary class/package execution. Compile the document with a full TeX toolchain for final output.

When a construct fails completely rather than differing typographically, reduce it to the smallest source that still fails and report the selected host/backend with the first relevant error. See [Troubleshooting](../guide/troubleshooting.md#report-a-reproducible-problem).
