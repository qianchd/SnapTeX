# SnapTeX Repository Change Log

This file records changes across the SnapTeX repository, including the VS Code extension, shared renderer, standalone web app, PWA packaging, and future hosts.

## Unreleased

- **Fixed**: Kept touch-driven Web pane resizing on the shared pointer-event path and made cancelled gestures leave the current layout unchanged.
- **Fixed**: Switched the standalone editor across included source files without rebuilding the root preview, preserving cross-file scroll position and skipping clean autosave writes.
- **Fixed**: Hardened Server project permission handling with explicit ACL masks and actionable unreadable-project responses.
- **Added**: Added shared preamble color extraction and CSS normalization for custom `\definecolor` values used by legacy and AST preview rules.
- **Changed**: Added shared dark-theme color adaptation for Web editor and preview content without command-specific color overrides.
- **Added**: Synchronized open server projects with external text-file edits using lightweight manifest revisions, conditional ETag reads, optimistic writes, and three-way conflict handling.

## [0.8.0] - 2026-08-16

- **Highlights**: Made the elastic paged preview the shared default across VS Code and Web hosts, with atomic blocks, flexible page bottoms, extended oversized pages, compact dividers, and page numbering.
- **Added**: Added low-memory background block-height warm-up, width-aware height reuse, and viewport anchoring to stabilize virtualized paged and continuous scrolling.
- **Added**: Added cross-host preview font size, line height, content width, and font family settings, including persistent Web preferences and page-width-relative typography.
- **Fixed**: Kept programmatic CodeMirror document loads outside undo history, improved character-range selection visibility, and kept the Web app on its welcome page until a project is chosen.
- **Fixed**: Versioned Web entry assets and made application-shell resources network-first so updated static and self-hosted deployments do not remain behind stale PWA caches.
- **Changed**: Simplified shared scanner, caption, style, and AST internals; removed the unused AST benchmark module; and enabled stricter TypeScript unused-code and control-flow checks.
- **Changed**: Renamed the local static deployment command to `npm run web:serve-static`.
- **Added**: Added a searchable VitePress documentation site and integrated it into the static GitHub Pages build under `/docs/` without adding documentation to the VSIX or server runtime.
- **Changed**: Reorganized user, deployment, developer, and extension documentation into task-oriented reading paths and documented every supported rule API with consistent value ownership and call relationships.
- **Changed**: Generalized splitter context preservation through registry-defined `context-wrapper` rules shared by coarse splitting and AST refinement.
- **Added**: Added an independently deployable SnapTeX Server security boundary with opaque browser sessions, CSRF protection, project-path confinement, and hardened systemd defaults.
- **Changed**: Kept the browser-session HTTP contract aligned with gpt-web-connecter while leaving both applications independently deployed and removing cross-service Nginx coupling.
- **Fixed**: Made PWA navigation network-first so self-hosted login redirects cannot be bypassed by a cached application shell while offline fallback remains available.
- **Fixed**: Routed expanded user-defined macros back through the shared AST rule registry, allowing custom preamble macros to wrap block-level preview structures without leaking raw LaTeX.

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
