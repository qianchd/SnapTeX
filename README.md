# SnapTeX: High-Performance LaTeX Live Previewer

**SnapTeX** is a lightweight, ultra-fast LaTeX previewer for Visual Studio Code. Unlike traditional previewers, it does not require a full TeX distribution (like TeXLive or MiKTeX) to function.

By using a custom high-speed regex parser, **KaTeX**, and **Markdown-It**, it provides near-instant structural and mathematical previews of your document, via several features including text-block splitter, diff checker and local renderer.

It is now a demo based on the early conceptual proof, [mume.parser](https://github.com/qianchd/mume.parser) for [MPE](https://github.com/shd101wyy/vscode-markdown-preview-enhanced).

## Features

* **Instant Math Rendering**: Real-time rendering of inline math `$ ... $` and complex display math environments (e.g., `equation`, `align`, `gather`) using KaTeX.
* **Intelligent Math Protection**: Uses a proprietary protection layer to ensure LaTeX math syntax is not corrupted by the Markdown parser.
* **Structural Previews**: Renders hierarchical headers (`\section` to `\subsubsection`), abstracts, and keywords with academic styling.

* **Smart Bi-Directional Sync**:
* **Forward Sync**: Jump from the editor cursor to the exact location in the preview.
* **Reverse Sync**: Double-click any element in the preview to jump to the corresponding line in the LaTeX source.


* **Macro Support**: Real-time expansion of `\newcommand`, `def` and `\DeclareMathOperator` definitions.

* **Advanced Environments Support (TODO)**:
* **Algorithms**: Renders pseudocode with keyword bolding (If, For, Return) and preserved indentation.
* **Tables**: Converts standard `tabular` environments into clean HTML tables with support for internal math rendering.
* **Figures**: Automatically resolves local image paths (e.g., `\includegraphics{figures/plot.png}`) and generates responsive webview previews.

## Requirements

SnapTeX is designed to be "zero-config." It works out of the box with no external dependencies.

* Simply open a `.tex` file and run the preview command.
* For math rendering, it uses an internal bundled version of KaTeX.

## Extension Settings

This extension contributes the following settings:

* `snaptex.renderDebounce`: Time in milliseconds to wait after the last keystroke before updating the preview (Default: `100`).
* `snaptex.enableIncrementalUpdate`: Enables high-performance patching of the preview instead of full re-renders for large documents.

## Known Issues

* **PDF Figures**: VS Code Webviews do not natively support `.pdf` files in `<img>` tags. It is recommended to use `.png` or `.jpg` for local figure previews.
* **Complex Packages**: Since this is a regex-based parser and not a full TeX engine, highly complex macro-heavy packages (like `tikz` or `pgfplots`) will be displayed as placeholders.
* **Citations**: Currently displays `[cite]` placeholders; dynamic BibTeX bibliography rendering is planned for future updates.

## Release Notes

### 0.0.1

* Initial release of SnapTeX.
* Implemented core Regex Parser with math protection.
* Added support for Sectioning, Theorems, and Proofs.
* Implemented Bi-directional Sync with anchor-text refinement.

---

## More Information

* **Project Home**: [GitHub Repository](https://github.com/qianchd/snaptex)
* **Report a Bug**: [Issue Tracker](https://github.com/qianchd/snaptex/issues)

---

### Next Step

1. Support figure, table, algorithm, e.t.c.
2. Periodically check errors via pdflatex, xelatex, ...
3. labels, refs, cites, ...
4. User-defined css styles and tex-parsers.