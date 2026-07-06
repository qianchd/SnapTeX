# SnapTeX: High-Performance LaTeX Live Previewer

> [!IMPORTANT]
> **New:** SnapTeX now has a pure static web version: **[Open SnapTeX Web](https://qianchd.github.io/SnapTeX/)**. Try the editor and live preview directly from GitHub Pages, with no VS Code extension install required.

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/icon.png">
  <img src="media/icon.png" alt="SnapTeX Logo" width="150">
</picture>
</div>

**SnapTeX** is a lightweight, ultra-fast LaTeX previewer for Visual Studio Code. Unlike traditional previewers, it does not require a full TeX distribution (like TeXLive or MiKTeX) to function.

It combines a custom high‑speed regex parser with **Markdown-It** and **KaTeX** to deliver near‑instant structural and mathematical previews. The result is a lightweight engine featuring a text‑block splitter, diff checker, and fully local rendering.

SnapTeX also runs in the browser via [vscode.dev](https://www.vscode.dev) or GitHub codespace, so you can use it from any device with an internet connection, making this ideal for tablets and other machines that don’t have a native VS Code install. Note that the SnapTeX preview itself is rendered entirely locally in the page, but you’ll need the ability to open the VS Code web site/Github codespace.

It is a demo based on the early conceptual proof, [mume.parser](https://github.com/qianchd/mume.parser) for [MPE](https://github.com/shd101wyy/vscode-markdown-preview-enhanced).

## Demo

<p align="center">
  <img src="media/demo/001.openPreview.gif" alt="Open a SnapTeX preview from a LaTeX document">
</p>

| Bi-directional sync | Auto scroll sync |
| --- | --- |
| <img src="media/demo/002.BiSync.gif" alt="Jump between LaTeX source and SnapTeX preview"> | <img src="media/demo/003.BiAutoScroll.gif" alt="Keep the LaTeX editor and SnapTeX preview scrolling together"> |

| References, figures, tables, algorithms, and tooltips | Fast local updates |
| --- | --- |
| <img src="media/demo/004.EqFigTableAlgoRefTooltips.gif" alt="Preview equations, figures, tables, algorithms, references, and tooltips"> | <img src="media/demo/005.FastLocalRendering.gif" alt="Fast local rendering updates in SnapTeX"> |

---

## What's New in 0.6.0

* **Default virtual mode for long documents**: SnapTeX now keeps lightweight block shells in the webview and mounts real block DOM only near the viewport, greatly reducing DOM, PDF, image, and TikZ memory pressure.
* **On-demand block HTML loading**: Large previews can send block metadata first and request HTML only when a block needs to render.
* **Smoother synchronization**: Editor-to-preview sync, preview-to-editor sync, reference jumps, and hover tooltips now work through virtualized blocks.
* **Faster, sturdier TikZ previews**: TikZJax is lazy-loaded, worker resources are bootstrapped safely inside VS Code webviews, unused libraries are pruned per picture, stale SVGs remain visible while rerendering, and compile failures are surfaced cleanly.
* **Better PDF handling**: PDF figures use webview-safe URI loading, viewport-near rendering, a blob module worker, and far-offscreen canvas release.
* **Stronger rendering safety and maintainability**: Generated HTML is protected explicitly, user-controlled HTML is escaped more consistently, and the renderer/webview code is split into clearer modules with broader tests.

## **SnapTeX Preview Quick Start Guide**

### Installation

Grab it from the Visual Studio Code Marketplace by searching for **SnapTeX** or visiting the [extension page](https://marketplace.visualstudio.com/items?itemName=qstatsite.snaptex).

### **How to Open the Preview**

* **Via Command Palette:** Open your `*.tex` file, press `Ctrl+Shift+p`, search for **"SnapTeX Preview: Start"**, and press `Enter`.
* **Via Shortcut:** Simply press the keyboard shortcut `Ctrl+k v` to launch the preview immediately.

### **Performance & Rendering**

* **Initial Load:** The first time you open the preview, it may take several seconds to complete the full rendering.
* **Real-Time Updates:** Once initialized, updates are processed locally, providing **instant, real-time rendering** as you type.
* **Virtual Mode:** `snaptex.virtualMode` is enabled by default. It keeps long previews responsive by mounting only viewport-near blocks while preserving scrollbar length with measured shell heights.
* **Lazy Heavy Resources:** PDF canvases and TikZ output are created only when their blocks are mounted near the viewport and can be released when far offscreen.

## Features

* **Instant Math Rendering**: Real-time rendering of inline math `$ ... $` and complex display math environments (e.g., `equation`, `align`, `gather`) using KaTeX.
* **Intelligent Math Protection**: Uses a proprietary protection layer to ensure LaTeX math syntax is not corrupted by the Markdown parser.
* **Structural Previews**: Renders hierarchical headers (`\section` to `\subsubsection`), abstracts, and keywords with academic styling.
* **Low-Memory Long Document Preview**: Uses block hashes, shell virtualization, on-demand HTML, and viewport-near resource mounting to keep large documents usable.

* **Smart Bi-Directional Sync**:
    * **Forward Sync**: Jump from the editor cursor to the exact location in the preview with `ctrl+alt+n`.
    * **Reverse Sync**: Double-click any element in the preview to jump to the corresponding line in the LaTeX source.
    * **Virtualized References and Tooltips**: Reference jumps and hover tooltips mount offscreen target blocks on demand, including nearby context blocks.

* **Auto Scrolling**:
    * `snaptex.autoScrollSync`: Enable cursor and scroll synchronization between editor and preview.
    * `snaptex.autoScrollDelay`: Debounce/Throttle delay (in ms) for scroll synchronization events.

* **Macro Support**: Real-time expansion of `\newcommand`, `\def` and `\DeclareMathOperator` definitions.

* **Advanced Environments Support (Basic demo works)**:
    * **Algorithms**: Renders pseudocode with keyword bolding (If, For, Return) and preserved indentation.
    * **Tables**: Converts standard `tabular` and common `tabularx` environments into clean HTML tables with support for internal math rendering.
    * **Figures**: Resolves local image paths and renders PDF/image figures through webview-safe resource URIs.
    * **TikZ**: Supported by TikZJax with lazy runtime loading, per-picture library pruning, and smoother rerendering after edits.

* **Label Reference**: Supports equation/section/figure/table/algorithm/theorem... labeling and cross-reference commands `ref,label,eqref`.

* **Citations**: Support dynamic BibTeX bibliography rendering, with a simple style and rendering rule for snap preview.

* **User-defined Rules**: under dev.

## Requirements

SnapTeX is designed to be "zero-config." It works out of the box with no external dependencies.

* Simply open a `.tex` file and run the preview command.
* For math rendering, it uses an internal bundled version of KaTeX.

## Known Issues and update plan

* Planned: broaden package support by adopting techniques similar to those used for TikzJax, enabling more familiar LaTeX packages in the preview.

## Dependence

* MarkdownIt: made parser simple
* KaTeX: for rendering math
* Pdfjs: for import pdf-type figures.
* Tikzjax: [Jim Fowler's original](https://github.com/kisonecat/tikzjax); [Glenn Rice's fork](https://github.com/drgrice1/tikzjax);

## For Developers and AI-assistants

* If you plan to add new features or rendering rules, please try your best to add them in the [@rules.ts](src/rules.ts) file. SnapTeX defines sufficient APIs for the extension possibilities.

* We plan to support user-defined rules in the future version.

---

**Enjoy writing LaTeX with SnapTeX!**
