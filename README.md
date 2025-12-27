# SnapTeX: High-Performance LaTeX Live Previewer

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/icon.png">
  <img src="media/icon.png" alt="SnapTeX Logo" width="150">
</picture>
</div>

**SnapTeX** is a lightweight, ultra-fast LaTeX previewer for Visual Studio Code. Unlike traditional previewers, it does not require a full TeX distribution (like TeXLive or MiKTeX) to function.

By using a custom high-speed regex parser, **KaTeX**, and **Markdown-It**, it provides near-instant structural and mathematical previews of your document, via several features including text-block splitter, diff checker and local renderer.

It is a demo based on the early conceptual proof, [mume.parser](https://github.com/qianchd/mume.parser) for [MPE](https://github.com/shd101wyy/vscode-markdown-preview-enhanced).

---

## **SnapTeX Preview Quick Start Guide**

### Installation

It can be installed from the VSC extension market. Find [SnapTeX](https://marketplace.visualstudio.com/items?itemName=qstatsite.snaptex).

### **How to Open the Preview**

* **Via Command Palette:** Open your `*.tex` file, press `Ctrl+Shift+p`, search for **"SnapTeX Preview: Start"**, and press `Enter`.
* **Via Shortcut:** Simply press the keyboard shortcut `Ctrl+k v` to launch the preview immediately.

### **Performance & Rendering**

* **Initial Load:** The first time you open the preview, it may take several seconds to complete the full rendering.
* **Real-Time Updates:** Once initialized, updates are processed locally, providing **instant, real-time rendering** as you type.

### **Syncing & Navigation**

* **Editor to Preview:** Press `Ctrl+Alt+n` in the editor to sync your cursor position and jump to the corresponding location in the preview panel.
* **Preview to Editor:** Double-click anywhere in the preview panel to automatically sync and jump to that specific line in the editor.

## Features

* **Instant Math Rendering**: Real-time rendering of inline math `$ ... $` and complex display math environments (e.g., `equation`, `align`, `gather`) using KaTeX.
* **Intelligent Math Protection**: Uses a proprietary protection layer to ensure LaTeX math syntax is not corrupted by the Markdown parser.
* **Structural Previews**: Renders hierarchical headers (`\section` to `\subsubsection`), abstracts, and keywords with academic styling.

* **Smart Bi-Directional Sync**:
    * **Forward Sync**: Jump from the editor cursor to the exact location in the preview with `ctrl+alt+n`.
    * **Reverse Sync**: Double-click any element in the preview to jump to the corresponding line in the LaTeX source.
* **Auto Scrolling**:
    * `snaptex.autoScrollSync`: Enable cursor and scroll synchronization between editor and preview.
    * `snaptex.autoScrollDelay`: Debounce/Throttle delay (in ms) for scroll synchronization events.


* **Macro Support**: Real-time expansion of `\newcommand`, `\def` and `\DeclareMathOperator` definitions.

* **Advanced Environments Support (Basic demo works)**:
    * **Algorithms**: Renders pseudocode with keyword bolding (If, For, Return) and preserved indentation.
    * **Tables**: Converts standard `tabular` environments into clean HTML tables with support for internal math rendering.
    * **Figures**: Automatically resolves local image paths (e.g., `\includegraphics{figures/plot.png}`) and generates responsive webview previews.

* **Label Reference**: Supports equation/section/figure/table/algorithm/theorem... labeling and cross-reference commands `ref,label,eqref`.

* **Citations**: Support dynamic BibTeX bibliography rendering, with a simple style and rendering rule for snap preview.

## Requirements

SnapTeX is designed to be "zero-config." It works out of the box with no external dependencies.

* Simply open a `.tex` file and run the preview command.
* For math rendering, it uses an internal bundled version of KaTeX.

## Extension Settings

## Requirements

## Known Issues and update plan

* **Complex Packages**: Since this is a regex-based parser and not a full TeX engine, highly complex macro-heavy packages (like `tikz` or `pgfplots`) will be displayed as placeholders.



---

**Enjoy writing LaTeX with SnapTeX!**