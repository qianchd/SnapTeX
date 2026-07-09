# SnapTeX Repository Change Log

This file records changes across the SnapTeX repository, including the VS Code extension, shared renderer, standalone web app, PWA packaging, and future hosts.

## Unreleased

## [0.7.1] - 2026-07-09

- **Added**: Added an experimental AST preview backend, including AST splitting, block artifacts, source hints, AST render rules, and backend switching through shared preview services.
- **Added**: Added repository documentation for the AST pipeline, rendering coverage, performance model, preview architecture, and sync model.
- **Added**: Added subfigure rendering and numbering coverage across the shared legacy/AST preview paths and the demo project.
- **Changed**: Improved the shared legacy preview runtime for algorithm rendering, table/list/TikZ handling, lazy block requests, layout-change notifications, and sync anchors.
- **Changed**: Improved the standalone web app with richer CodeMirror LaTeX support, default demo project loading, editor/preview sync refinements, and cleaner host state handling.
- **Changed**: Reworked tests around behavior-level AST/legacy rendering, standalone host flows, web assets, source sync, and representative preview regressions while pruning low-value implementation-detail tests.
- **Fixed**: Stabilized webview scroll state during patch updates that change block boundaries while auto-scroll sync is enabled.
- **Removed**: Removed the development-only `todo.md` from the main branch; ongoing planning stays on development branches.

## [0.7.0] - 2026-07-07

- **Added**: Added a standalone browser-hosted SnapTeX app built on CodeMirror.
- **Added**: Added browser project support with multi-file loading, lazy text/resource reads, image/PDF resource resolution, project diagnostics, file switching, preview-root switching, dirty-file tracking, and File System Access save support.
- **Added**: Added CodeMirror LaTeX editing assistance.
- **Added**: Added bidirectional editor/preview synchronization for the standalone web app.
- **Added**: Added static PWA packaging, service-worker offline cache, local static serving, and GitHub Pages deployment workflow.
- **Changed**: Refactored the VS Code host under `apps/vscode` and extracted host-neutral preview update and browser file-provider pieces.
- **Changed**: Refined the standalone web UI.
- **Fixed**: Prevented CRLF files opened through browser folder loading from being marked dirty until edited.
