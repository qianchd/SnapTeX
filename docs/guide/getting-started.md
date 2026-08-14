# Your First Preview

This walkthrough starts with a small root document and ends with rendering, saving, and two-way source navigation. Choose either the VS Code path or the Web path; you do not need to complete both.

You do not need TeX Live or MiKTeX for this structural preview.

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

::: tip Root versus active file
The active file is the tab you are editing. The root document supplies project-wide macros, metadata, citations, and relative paths. They may be the same file, but they do not have to be.
:::

## 2. Open the project in one host

### VS Code path

1. Open `main.tex` in the editor.
2. Press `Ctrl+K V` on Windows/Linux or `Cmd+K V` on macOS.
3. Wait for the first structural preview to appear.

Keep the preview open. The saving and navigation checks below apply after this point.

### Web path

From the welcome page, choose one of these actions:

- **Open Folder** to work directly with a browser-granted local directory;
- **Import Folder** to copy a project into persistent browser storage;
- **Open Demo** to create a reusable demo workspace.

Select `main.tex` in Explorer. If another `.tex` file is currently the root, use **Set Root**.

The demo already contains a root document. For your own source, **Open Folder** writes to a supported local directory, while **Import Folder** creates an independent browser workspace.

## 3. Wait for the first render

The initial render extracts metadata and supported macros, resolves included source, creates source mappings, scans numbering and references, and builds lightweight preview shells. In virtual mode, HTML and expensive resources are requested only near the viewport.

TikZ and PDF support may therefore activate later than ordinary text and math. Subsequent edits normally update only changed blocks and unchanged blocks whose document-level inputs, such as title metadata or cited keys, changed.

Do not judge the initial load only by a TikZ or PDF block that is still outside the viewport. Scroll near the block before treating the unloaded resource as a failure.

## 4. Edit and save

Change `Introduction` to `Overview`. The preview should update without reopening it.

Then save with `Ctrl+S` or `Cmd+S`:

| Project type | What save does |
| --- | --- |
| VS Code workspace | Uses VS Code's normal file save |
| Web direct folder | Writes through the granted file handle |
| Web imported workspace or demo | Persists the current text to IndexedDB |
| Remote server project | Sends an authenticated write to the project API |

The Web app marks modified files until the selected storage backend confirms the save. Browser workspaces are persistent working copies, but use **Export ZIP** for a portable backup.

## 5. Test source navigation

1. Place the editor cursor in the introduction.
2. Press `Ctrl+Alt+M` (`Cmd+Alt+M` on macOS) to reveal it in the preview.
3. Double-click a visible sentence in the preview to return to the source.
4. Click the rendered equation reference to jump to its target; hover it to open the tooltip.

## What success looks like

After completing either host path:

- the title, section heading, prose, and equation appear without raw LaTeX commands leaking into the preview;
- `Equation 1` links to the numbered display;
- source-to-preview and preview-to-source navigation both reveal the expected sentence;
- editing the section heading updates the preview without reopening it;
- saving clears the modified-file indicator in the active host.

If the result differs, first confirm that `main.tex` is the root, then use the symptom-based [Troubleshooting](./troubleshooting.md) guide.

## Next steps

- [VS Code Extension](./vscode.md)
- [Web App](./web.md)
- [Projects and Files](./projects.md)
- [Sync and Navigation](../features/sync.md)
- [Troubleshooting](./troubleshooting.md)
