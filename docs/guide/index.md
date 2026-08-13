# User Guide

This part of the documentation is for people writing LaTeX with SnapTeX. It covers installation, opening a project, saving files, navigating between source and preview, and solving common problems. You do not need to understand SnapTeX's TypeScript architecture or rendering-rule APIs to use it.

## Choose where to run SnapTeX

| Host | Choose it when | Where files live |
| --- | --- | --- |
| VS Code extension | You already edit a local repository in VS Code | Your VS Code workspace |
| Static Web/PWA | You want a browser editor, an offline app, or a portable browser workspace | A local folder handle or browser IndexedDB |
| SnapTeX Server | A self-hosted machine should store named projects | The configured server project directory |

For most desktop work, start with the VS Code extension. To try SnapTeX without installing an extension, open the public Web app and choose **Open Demo**.

## Recommended learning path

1. [Install SnapTeX](./installation.md) or open the Web app.
2. Follow [Your First Preview](./getting-started.md).
3. Read the host guide for [VS Code](./vscode.md) or the [Web app](./web.md).
4. Learn how SnapTeX resolves [projects and files](./projects.md).
5. Review [rendering support](../features/rendering.md) and [sync controls](../features/sync.md).
6. Keep [Troubleshooting](./troubleshooting.md) nearby when a preview behaves unexpectedly.

## What SnapTeX is

SnapTeX is a fast structural preview. It renders prose, math, references, citations, figures, PDFs, tables, algorithms, theorem-like environments, and TikZ without requiring a local TeX distribution.

SnapTeX does not try to reproduce final page breaks, float placement, class-specific typography, or arbitrary package execution. Use a complete TeX toolchain for publication output.

## Privacy and storage

The public static Web app renders local and imported projects in your browser. Local project contents are not uploaded by that edition. Imported projects and the demo are stored in browser IndexedDB, so export important work as ZIP.

Remote projects exist only in a separately deployed server edition. Opening one requires authentication, and its files remain under that server's configured project root.

## Developer documentation

If you are changing SnapTeX itself, begin with the [Developer Guide](../development/index.md). Rendering extensions, metadata extractors, dependency rules, and splitter settings are documented separately and are assembled through one source-level entry point: `src/rules.ts`.
