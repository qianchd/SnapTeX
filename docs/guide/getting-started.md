# Your First Preview

This walkthrough starts with a small project and ends with a working source/preview navigation loop.

## 1. Create a root document

Use a file such as `main.tex`:

```latex
\documentclass{article}
\usepackage{amsmath}

\title{A SnapTeX Preview}
\author{Example Author}

\begin{document}
\maketitle

\section{Introduction}
The preview updates while you write. Inline math such as $p > n$ is rendered by KaTeX.

\begin{equation}\label{eq:demo}
  y = X\beta + \varepsilon.
\end{equation}

Equation~\ref{eq:demo} is linked to its preview anchor.
\end{document}
```

The root document owns the preamble and resolves included files, bibliography databases, images, and PDFs. Even when you are editing an included file, keep the preview rooted at `main.tex`.

## 2. Open it in VS Code

1. Open `main.tex` in the editor.
2. Press `Ctrl+K V` on Windows/Linux or `Cmd+K V` on macOS.
3. Wait for the first structural preview to appear.
4. Place the editor cursor in the introduction and press `Ctrl+Alt+M` (`Cmd+Alt+M` on macOS).
5. Double-click a sentence in the preview to return to its source.

By default, live preview and automatic scroll synchronization are enabled. Save behavior, delays, virtualization, and backend selection are available under VS Code Settings by searching for **SnapTeX**.

## 3. Open it in the Web app

From the welcome page, choose one of these actions:

- **Open Folder** to work directly with a browser-granted local directory;
- **Import Folder** to copy a project into persistent browser storage;
- **Open Demo** to create a reusable demo workspace.

Select `main.tex` in Explorer. If another `.tex` file is currently the root, use **Set Root**. Press `Ctrl+S` or `Cmd+S` to save the active file through the current workspace backend.

Use `Ctrl+Alt+M` to reveal the editor cursor in the preview. Double-click preview content for the reverse direction.

## 4. Understand the first load

The initial render extracts metadata and supported macros, resolves included source, creates block/source mappings, scans numbering and references, and builds lightweight preview shells. In virtual mode, HTML and heavy resources are requested only near the viewport.

TikZ and PDF support may therefore activate later than ordinary text and math. Subsequent edits normally update only changed or dependency-dirty blocks.

## 5. Check saving

Saving depends on the project type:

| Project type | What save does |
| --- | --- |
| VS Code workspace | Uses VS Code's normal file save |
| Web direct folder | Writes through the granted file handle |
| Web imported workspace or demo | Persists the current text to IndexedDB |
| Remote server project | Sends an authenticated write to the project API |

The Web app marks modified files until the current backend confirms a save. Use **Export ZIP** for a portable snapshot of a browser workspace.

## Next steps

- [VS Code Extension](./vscode.md)
- [Web App](./web.md)
- [Projects and Files](./projects.md)
- [Sync and Navigation](../features/sync.md)
- [Troubleshooting](./troubleshooting.md)
