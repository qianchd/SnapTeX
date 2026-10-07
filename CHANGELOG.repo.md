# SnapTeX Repository Change Log

This file records changes across the SnapTeX repository, including the VS Code extension, shared renderer, standalone web app, PWA packaging, and future hosts.

## Unreleased

- **Fixed**: Retained and retried external project updates after temporary network, file-read, or delivery failures instead of marking them as handled. Server projects catch up after reconnection or returning to the tab without restoring continuous manifest polling.
- **Fixed**: Prevented stale reads and post-save metadata from hiding newer edits, caught changes made while local monitoring starts, and kept failed files from blocking other updates. Failed preview refreshes rebuild on retry without replacing the editor again; stalled remote sync reads time out and pending watcher requests are cancelled when closing a project.

## [0.8.2] - 2026-10-05

- **Highlights**: Added Web PDF viewing with offline SyncTeX navigation, server-side PDF compilation, and event-driven automatic saving that preserves editor position and undo history.
- **Added**: Opened project PDFs directly from Explorer in a dedicated PDF.js viewer with page navigation, zoom, downloads, an auto-hidden toolbar, and a return to TeX preview.
- **Added**: Bound `Ctrl+B` to authenticated server-project compilation with TinyTeX, `latexmk`, or automatic compiler detection; enabled SyncTeX output, surfaced compilation errors, and refreshed already-open PDFs without changing their view location.
- **Added**: Offline PDF/source synchronization for local folders, browser workspaces, and server projects using the bundled official SyncTeX parser in a Worker; supports double-click, `Ctrl+Alt+M`, and the existing auto-scroll setting without per-query server requests. Source files not yet loaded from a server still require a network connection.
- **Changed**: Replaced remote manifest polling with filesystem-watcher SSE notifications and conditional text reads. Refreshed open PDFs and their SyncTeX indexes through project file watchers; removed the server-side SyncTeX query endpoint and CLI requirement.
- **Added**: Configurable Web auto save, enabled by default for dirty writable files after a one-second quiet edit delay, using the same serialized save and external-update pipeline as manual saving without periodic polling.
- **Fixed**: Preserved editor selection and undo history during saves and external text updates; retained edits typed while a save is in progress and merged non-overlapping external changes before saving.
- **Fixed**: Checked saved-text baselines before local-folder and IndexedDB writes, paired remote text with its ETag, and serialized server writes to reject stale browser saves without silently replacing newer text.
- **Fixed**: Kept PDF refresh positions scoped to the same document, ignored superseded loads, and released the viewer and SyncTeX Worker when closing PDF preview.
- **Added**: Added Solarized Light, Skyblue, and GitHub Light Web themes with theme-aware branding and browser/PWA window colors.
- **Changed**: Disabled automatic scroll sync and diagnostic-panel visibility by default on the Web without overriding saved preferences.
- **Fixed**: Unified project-relative image and PDF path resolution across VS Code and Web, including parent-directory references inside the opened project while rejecting paths that escape it.
- **Fixed**: Preserved intermediate `\hline`, `\cline`, and booktabs rules in both rendering backends, including adjacent column ranges across spanning cells.
- **Changed**: Separated AST element rules from text/layout compatibility rules, simplified shared rendering dispatch, and released stale virtual-shell observers, tooltip timers, and embedded PDF loading tasks.
- **Changed**: Updated SVG branding and raster exports, generated a high-contrast installed-PWA icon, and kept Web/server-only assets out of VSIX packages.
- **Added**: Added a reusable SSH deployment command that invokes the existing server installer while keeping deployment addresses and credentials out of tracked configuration.
- **Testing**: Streamlined behavior-level tests and added GitHub Actions coverage for shared/server code and VS Code on Linux, Windows, and macOS, including the minimum supported VS Code version and production Web/PWA/documentation assets.
- **Maintenance**: Updated the VS Code test runner to remove deprecated `inflight` and `glob@7` installation dependencies.

## [0.8.1] - 2026-09-13

- **Highlights**: Modernized the Web workspace with persistent project history and settings, responsive mobile panes, richer search controls, remote synchronization, and optional remembered server sessions.
- **Added**: Modernized standalone editor search with match counts, compact match controls, and shared Lucide icons for search and pane navigation.
- **Added**: Persisted the selected preview root for every Web project through one shared project-state store.
- **Added**: Added separate CSS-shorthand page and continuous-preview margin settings across VS Code and Web.
- **Added**: Added persistent standalone Web editor font size and font family controls alongside explicitly named preview typography settings.
- **Added**: Added unified recent-project history for browser workspaces, local directory handles, and remote project names without duplicating local or remote project contents.
- **Added**: Added optional 30-day server sessions with server-side persistence across service restarts and deployment swaps while retaining logout revocation and the default eight-hour lifetime.
- **Fixed**: Persisted all standalone Web settings across projects and browser restarts instead of retaining only preview typography.
- **Added**: Added responsive standalone Web layouts that reuse the existing pane state and defer synchronization while either portrait pane is hidden, while preserving the resizable dual-pane workspace in landscape.
- **Fixed**: Kept touch-driven Web pane resizing on the shared pointer-event path and made cancelled gestures leave the current layout unchanged.
- **Fixed**: Switched the standalone editor across included source files without rebuilding the root preview, preserving cross-file scroll position and skipping clean autosave writes.
- **Fixed**: Hardened Server project permission handling with explicit ACL masks and actionable unreadable-project responses.
- **Added**: Added shared preamble color extraction and CSS normalization for custom `\definecolor` values used by legacy and AST preview rules.
- **Changed**: Added shared dark-theme color adaptation for Web editor and preview content without command-specific color overrides.
- **Added**: Synchronized open server projects with external text-file edits using lightweight manifest revisions, conditional ETag reads, optimistic writes, and three-way conflict handling.
- **Changed**: Reduced AST splitter, renderer, artifact, and shared host-state complexity while preserving public extension APIs and background warm-up behavior.
- **Changed**: Accelerated shared AST incremental splitting and rendering by eliminating repeated scans, duplicate algorithm math rendering, and redundant artifact rebuilding; avoided unchanged pagination style writes and unnecessary viewport-anchor scans.
- **Fixed**: Made AST and legacy rendering more robust for nested theorem titles and command arguments, source-complete math, `alignat`, `\mbox`, starred `\includegraphics`, and optional section titles.
- **Fixed**: Unified AST citation metadata and rendering argument reads, including spaced optional arguments, and retained minimal AST parsing when full post-processing fails.
- **Added**: Added a reusable arXiv source audit for a target of 100 mathematics and statistics projects. It renders each root document through both backends and reports rendering failures, leaked commands, math errors, and backend differences; downloaded sources stay out of Git and release packages.
- **Added**: Broadened shared rendering support for declared theorem and list wrappers, long tables and math environments, `algorithm2e`, subfigures, standalone graphics, `tikz-cd`, common reference and `siunitx` commands, and biblatex bibliographies.
- **Fixed**: Preserved simple `\let` definition snapshots and unbraced macro arguments across text and math rendering, and suppressed nonvisual template commands instead of leaking them into previews.
- **Fixed**: Kept preview scrolling authoritative until the next editor interaction, preventing reverse-sync rebound in VS Code and the standalone Web app, including hidden-pane layouts.

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
