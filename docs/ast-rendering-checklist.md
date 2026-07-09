# AST Rendering Parity Checklist

Use this checklist when comparing legacy and AST preview output. The goal is
preview parity for common author workflows, not pixel-perfect LaTeX compilation.

| Area | Representative snippet | Expected AST behavior | Automated coverage |
| --- | --- | --- | --- |
| Inline math with macros | `The bound is $1 - p_n - n^{-C}$.` plus preamble macros | KaTeX renders inline math with the current macro table. | `PreviewUpdateService` math macro tests |
| Theorem/condition/proof | `\begin{condition}[Title] ... \begin{enumerate} ...` | Environment wrapper, optional title, nested lists, and math all render without raw LaTeX leakage. | theorem/list tests |
| Long style groups | `{\color{blue} ... \begin{remark} ... }` | Decorator style is carried across refined blocks without swallowing block structure. | AST-split color tests |
| Sections and labels | `\subsubsection*{Case 2: $\Hcal_2 = \emptyset$}` | Starred heading has no counter prefix; inline math renders. | starred section tests |
| Refs and citations | `\ref*{lem:x}`, `\eqref{eq:x}`, `\citep[see][p. 2]{a,b}` | Links render through the same label/citation context as legacy. | ref/citation tests |
| Tables | `threeparttable`, `tabular*`, `makecell`, `\tnote` | Preview table structure, captions, labels, and notes render; full LaTeX layout is not required. | nested table tests |
| Algorithms | `algorithm` + `algorithmic` with `\REQUIRE`, `\STATE`, `\FOR`, `\IF` | Caption/label render, options are hidden, list rows and indentation are preserved. | algorithmic tests |
| Bibliography | external `.bib` and inline `thebibliography` | Citation anchors and bibliography entries render with the shared bib parser. | bibliography tests |
| TikZ and graphics | `tikzpicture`, `\includegraphics{figure.pdf}` | AST mode emits the same TikZ/PDF/image placeholder contract as legacy. | TikZ/PDF lazy render tests |

## Manual Long-Document Pass

For `src/localtestTeX/main_arxiv_v3.tex`, compare legacy and AST mode around:

* first open in virtual mode;
* long colored proof/remark sections;
* dense theorem/list blocks;
* table-heavy appendix sections;
* TikZ figures after scrolling from the top;
* editor-to-preview and preview-to-editor sync around repeated text.

