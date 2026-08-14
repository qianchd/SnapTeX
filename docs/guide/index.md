# User Guide

This guide is for writing LaTeX with SnapTeX. You do not need to understand the TypeScript architecture, AST backend internals, or rendering-rule API.

## Start in two minutes

Choose one route:

- **VS Code:** [install the extension](./installation.md#vs-code-extension), open the root `.tex` file, and press `Ctrl+K V` (`Cmd+K V` on macOS).
- **Browser:** open [SnapTeX Web](https://qianchd.github.io/SnapTeX/) and choose **Open Demo**.

Confirm that text and math render. Then use `Ctrl+Alt+M` (`Cmd+Alt+M` on macOS) to move from source to preview and double-click preview text to return.

The [first-preview walkthrough](./getting-started.md) provides a complete sample document and explains what a successful first load looks like.

## Choose one host

| Host | Choose it when | Where files live | Account required |
| --- | --- | --- | --- |
| VS Code extension | You already edit a local repository in VS Code | Your VS Code workspace | No |
| Static Web/PWA | You want a browser editor, an offline app, or a portable browser workspace | A local folder handle or browser IndexedDB | No |
| SnapTeX Server | A self-hosted machine should store named projects | The configured server project directory | Yes, for remote projects |

For most desktop work, start with the VS Code extension. To try SnapTeX without installing an extension, open the public Web app and choose **Open Demo**.

The hosts share the same rendering core. Their main difference is where project files live and which editor/file APIs are available.

## Recommended reading path

1. [Install SnapTeX](./installation.md) or open the Web app.
2. Follow [Your First Preview](./getting-started.md) using one host path.
3. Read only the matching host guide: [VS Code](./vscode.md) or [Web app](./web.md).
4. Learn the difference between root, active file, and storage in [Projects and Files](./projects.md).
5. Use [Rendering Support](../features/rendering.md), [Sync and Navigation](../features/sync.md), and [Settings](../reference/settings.md) as task references.
6. Start from the symptom in [Troubleshooting](./troubleshooting.md) when something fails.

## What SnapTeX is

SnapTeX is a fast structural preview. It renders prose, math, references, citations, figures, PDFs, tables, algorithms, theorem-like environments, and TikZ without requiring a local TeX distribution.

SnapTeX does not try to reproduce final page breaks, float placement, class-specific typography, or arbitrary package execution. Use a complete TeX toolchain for publication output.

## Terms used in this guide

| Term | Meaning |
| --- | --- |
| **Project** | A root document plus included source, bibliography, image, PDF, class, and style files. |
| **Root document** | The `.tex` file that owns the preamble and `\begin{document}`. Start or set the preview from this file. |
| **Structural preview** | Readable HTML that preserves document meaning without reproducing TeX pagination exactly. |
| **Backend** | The source-processing path. `legacy` is the stable default; `ast(experimental)` is available for testing. |
| **Virtual mode** | The default long-document mode that mounts only viewport-near block HTML while retaining the full scrollbar and source map. |

## Privacy and storage

The public static Web app renders local and imported projects in your browser. Local project contents are not uploaded by that edition. Imported projects and the demo are stored in browser IndexedDB, so export important work as ZIP.

Remote projects exist only in a separately deployed server edition. Opening one requires authentication, and its files remain under that server's configured project root.

::: warning Browser workspaces are not backups
IndexedDB survives ordinary page closes, but browser data can be removed by the user, private-browsing policy, or storage pressure. Use **Export ZIP** for work you cannot afford to lose.
:::

## Developer documentation

If you are changing SnapTeX itself, begin with the [Developer Guide](../development/index.md). Rendering extensions, metadata extractors, dependency rules, and splitter settings are documented separately and are assembled through one source-level entry point: `src/rules.ts`.
