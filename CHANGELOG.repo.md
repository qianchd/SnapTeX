# SnapTeX Repository Change Log

This file records changes across the SnapTeX repository, including the VS Code extension, shared renderer, standalone web app, PWA packaging, and future hosts.

## Unreleased

## [0.7.0] - 2026-07-07

- **Added**: Added a standalone browser-hosted SnapTeX app built on CodeMirror.
- **Added**: Added browser project support with multi-file loading, lazy text/resource reads, image/PDF resource resolution, project diagnostics, file switching, preview-root switching, dirty-file tracking, and File System Access save support.
- **Added**: Added CodeMirror LaTeX editing assistance.
- **Added**: Added bidirectional editor/preview synchronization for the standalone web app.
- **Added**: Added static PWA packaging, service-worker offline cache, local static serving, and GitHub Pages deployment workflow.
- **Changed**: Refactored the VS Code host under `apps/vscode` and extracted host-neutral preview update and browser file-provider pieces.
- **Changed**: Refined the standalone web UI.
- **Fixed**: Prevented CRLF files opened through browser folder loading from being marked dirty until edited.