# Change Log

All notable changes to the "SnapTeX" extension will be documented in this file.

## Unreleased

- **Added**: Added persistent Web editor font size and font family settings, and clarified the corresponding preview typography labels.
- **Added**: Added a unified Web project history for imported/demo workspaces, browser-granted local folders, and server project names, with permission and authentication checks when entries are reopened.
- **Added**: Added an optional 30-day server login backed by revocable server-side sessions that survive service restarts and atomic deployments; the default session remains eight hours.
- **Fixed**: Persisted the complete Web settings state across projects and browser restarts, including behavior, backend, layout, theme, panel visibility, diagnostics, delays, and preview typography.
- **Added**: Added responsive Web layouts with contained welcome actions, an overlay file explorer, a portrait Editor/Preview switch with deferred bidirectional synchronization that never measures hidden panes, and the existing resizable dual-pane workspace in landscape.
- **Fixed**: Made the Web editor/preview divider draggable with touch input without an interrupted gesture collapsing either pane.
- **Fixed**: Kept the Web preview stable while scroll synchronization crosses `\\input` file boundaries, and avoided redundant browser-workspace writes when the synchronized editor file is unchanged.
- **Fixed**: Repaired remote-project ACL masks during Server deployment and reported unreadable project paths explicitly instead of returning an unexplained manifest error.
- **Added**: Resolved custom preamble colors declared with common `\definecolor` models across legacy and AST rendering, including direct model syntax and xcolor-style color mixes.
- **Changed**: Made the Web editor fully black in dark mode and adapted LaTeX colors, citations, and bibliography links to brighter theme-aware preview colors.
- **Added**: Kept open server projects synchronized with external file edits through lightweight revision polling, conditional ETag reads, and automatic preview refreshes.
- **Added**: Added optimistic remote saves with three-way text merging: independent browser/server edits merge automatically, while overlapping edits produce visible conflict markers instead of silently overwriting either side.
- **Changed**: Minified production Web bundles and added build-time Brotli plus gzip assets for the server edition, reducing the main browser bundle from about 3.3 MB of development JavaScript to about 372 KB over Brotli.
- **Changed**: Added per-file asset hashes, versioned static URLs, ETag/304 responses, immutable caching for versioned assets, and revalidation caching for HTML and the Service Worker.
- **Changed**: Kept the complete PWA available offline while splitting its cache into reusable core, KaTeX, PDF.js, TikZ, and demo groups, so upgrades download only resource groups whose contents changed.
- **Changed**: Deferred PWA preparation until the initial page is usable, removed the duplicate Service Worker probe request, and exposed offline preparation/readiness in the Web toolbar.

## [0.8.0] - 2026-08-16

- **Highlights**: Made the elastic paged preview the default layout, keeping rendered blocks intact while using flexible page-bottom space and extended pages for oversized proofs, styled groups, tables, figures, TikZ, and PDF blocks. Continuous preview remains available in settings.
- **Added**: Exposed preview font size, line height, content width, and font family settings in both VS Code and the Web app, with immediate layout refresh, height-cache recalculation, and cross-project Web persistence; content width now also constrains and centers paged pages, and container-relative font units resolve against the continuous content or paged paper width.
- **Changed**: Added a one-block-at-a-time virtual height warm-up pass that stabilizes long-document scroll geometry without retaining offscreen measurement DOM or generated SVG nodes, measures PDF page geometry without rasterizing a canvas bitmap, and reuses cached height data across compatible preview widths.
- **Fixed**: Matched background height measurement to the mounted block layout, refreshed width-sensitive heights after pane resizing, and waited for final TikZ SVG cropping before caching its height.
- **Changed**: Centered paged paper within the configured content width, kept the surrounding preview background visible, and replaced shadows and inter-page gaps with a compact divider and smaller page numbers matching the document typography.
- **Fixed**: Made character-range selections clearly visible in the Web editor instead of letting the active-line background obscure the selected text.
- **Fixed**: Matched reference tooltip typography to the preview text and anchored page markers to page-start blocks so virtualized height corrections cannot leave dividers crossing rendered content.
- **Added**: Replaced the internal notes under `docs/` with a searchable VitePress documentation site covering user workflows, rendering, deployment, security, extension APIs, architecture, performance, and testing.
- **Changed**: Reorganized the documentation around separate user, self-hosting, and contributor paths, with task-oriented navigation and explicit ownership, call relationships, parameter sources, and return contracts throughout the rendering-rule API.
- **Changed**: Replaced splitter-specific begin-token matching with reusable `context-wrapper` rules so declaration-style groups and argument-wrapping commands share one configurable coarse-protection and AST-refinement model.
- **Added**: Added an optional self-hosted Web project API with named projects, project creation, lazy remote file loading, in-place text saves, resource URLs, and repository-managed one-command server installation.
- **Added**: Added shared text-file creation and deletion for writable local folders and remote Web projects, including `.tex`, `.bib`, `.md`, and other supported source files.
- **Added**: Added persistent browser workspaces backed by IndexedDB, conflict-aware folder re-import, lazy resource reads, project ZIP export, and browser-backed demo editing.
- **Added**: Secured self-hosted SnapTeX projects with independent server-side Web Sessions, same-origin login, CSRF validation, login lockout, hardened response headers, and a loopback-only deployment model.
- **Security**: Made authentication mandatory whenever the remote project API is enabled, isolated server deployments on a dedicated origin, added bounded per-IP failure tracking with a 30-day block after ten failures within 30 minutes, and rejected unsafe static-file paths and methods.
- **Security**: Hardened the remote project server with centralized credential validation, separate static/project roots, bounded request headers and timeouts, control-character path rejection, and fail-closed login-failure tracking.
- **Changed**: Reduced browser-workspace memory with sequential SHA-256 hashing and disposable lazy resource blobs, preserved local edits with three-way re-import checks, retained custom roots, and enforced file/root invariants in IndexedDB.
- **Changed**: Limited Web Session authentication to remote server projects so the welcome page, local-folder editing, and demo remain available without signing in.
- **Changed**: Added explicit static and server Web deployment modes; GitHub Pages now shows server deployment guidance without probing unavailable session or project APIs, while the server installer enables authenticated remote projects.
- **Changed**: Simplified public deployment to an ordinary HTTPS Nginx reverse proxy; SnapTeX no longer requires cross-service authentication or proxy-secret configuration.
- **Fixed**: Made PWA page navigation network-first so self-hosted updates and on-demand server authentication are not masked by a cached application shell.
- **Fixed**: Scoped PWA cache cleanup and lookups to the current SnapTeX deployment so colocated applications and other SnapTeX paths keep their own caches.
- **Added**: Added a local-first web welcome screen, persistent demo editing, a larger auto-hidden toolbar trigger, and collapsible editor/preview panes.
- **Fixed**: Kept Web startup on the welcome screen instead of automatically reopening the latest workspace, and versioned the application entry so an older PWA cache cannot restore the previous demo-first behavior.
- **Fixed**: Kept programmatic project and file loads out of CodeMirror's undo history so repeated undo stops at the loaded document instead of clearing it.
- **Changed**: Renamed the local static deployment command to `npm run web:serve-static` to distinguish it from the authenticated Server edition.
- **Fixed**: Let user-defined text macros wrap block structures such as tables, figures, lists, and theorem environments in the AST backend by routing expanded macro content through the shared AST rule pipeline.
- **Fixed**: Kept source synchronization accurate when comments contain document markers such as `% \begin{document}`.
- **Fixed**: Restored external bibliography rendering in the AST backend by carrying the document citation set into AST render contexts.
- **Changed**: Unified citation resolution across HTML and TikZ rendering so `\cite`, `\citep`, `\citet`, `\citeyear`, and `\citenum` are converted before TikZJax compilation in both preview backends.
- **Fixed**: Restored PDF and TikZ rendering in the Web host by resolving deployed runtime assets against the page URL, permitting browser-local Blob resources, and preserving custom PGF shape definitions and bold-symbol macros in TikZ previews.

## [0.7.1] - 2026-07-09
- **Added**: Added the experimental `snaptex.backendMode` setting with an AST-assisted preview backend for testing structured splitting, rendering, dependencies, and source sync while keeping the legacy backend as the default.
- **Added**: Added AST-aware rendering support for sections, math, citations, links, lists, floats, tables, algorithms, theorem/proof wrappers, TikZ, and source-sync anchors.
- **Added**: Added `subfigure` rendering in both legacy and AST preview backends, including side-by-side layouts, subcaptions, subfigure numbering, and subfigure label references.
- **Changed**: Improved the legacy rendering/runtime path for algorithms, nested lists, table notes, TikZ/PDF lazy blocks, preview layout changes, and bidirectional sync messages.
- **Changed**: Improved AST and legacy preview behavior with source-hint based inline math sync, backend reset handling, and warm AST artifact generation for patched blocks.
- **Changed**: Focused the automated test suite on behavior-level rendering, sync, web host, and AST/legacy integration coverage.
- **Fixed**: Stabilized preview auto-scroll during patch updates that split or merge nearby blocks.

## [0.7.0] - 2026-07-07
- **Changed**: Refactored the VS Code host under `apps/vscode` while preserving the existing VS Code preview workflow.
- **Changed**: Reused the shared preview update pipeline in the VS Code extension.
- **Fixed**: Aligned preview tooltips with the VS Code preview pane.
- **Fixed**: Improved VSIX packaging so web/PWA build artifacts are not included in extension packages.

## [0.6.5] - 2026-07-03
- **Changed**: Reduced initial preview work in virtual mode by shrinking the first-load and normal block mount windows, improving long-document first-open speed and lowering peak webview memory usage.
- **Changed**: Pruned cached on-demand block HTML after virtual cleanup when shells move outside the retain window, so scrolling through long documents no longer keeps every previously visited block's HTML in memory.
- **Changed**: Kept PDF and TikZ work lazy under virtual mode: only mounted blocks trigger heavy preview work, while offscreen shells continue to hold lightweight metadata and measured heights.
- **Changed**: Removed the old `snaptex.experimentalVirtualization` compatibility setting; `snaptex.virtualMode` is now the only virtual preview switch.
- **Fixed**: Smoothed upward scrolling in virtual mode by compensating above-viewport shell height changes, including asynchronous media/TikZ/PDF height updates, without widening the preload window.
- **Added**: Supported common `enumerate` optional label templates such as `[(a)]`, `[(i)]`, `[$G_1$]`, and `[$H_a$]` by replacing `1`, `i`, or `a` counters inside the label template.
- **Fixed**: Render theorem-like environments as containers so nested lists, tables, and other block rules can render inside definitions, theorems, lemmas, and related environments.

## [0.6.4] - 2026-06-30
- **Changed**: More stable styling, e.g., `{\it ...}`, `{\color{blue} ...}`.
- **Changed**: stabilize bidirectional preview synchronization.
- **Changed**: Support old vscode version.
- **fixed**: stripLatexComments breaks lines in preamble field.

## [0.6.3] - 2026-06-21
- **Added**: Introduced an extensible rule registry with `metadataExtractors`, `renderRules`, and `blockDependencyRules`, making custom metadata and dependency-aware rendering rules configurable from `rules.ts`.
- **Added**: Moved splitter configuration into `rules.ts`, including configurable line budgets, split environments, no-emergency-split environments, protected begin tokens, and emergency split recovery rules.
- **Added**: Added structured title metadata for `\maketitle`, including multi-author names, emails, affiliations, keywords, and custom metadata fields.
- **Added**: Supported common author/affiliation metadata styles, including repeated `\author`/`\email`/`\affiliation`, authblk-style `\author[1]`/`\affil[1]`, `\inst`/`\institute`, IEEE author blocks, and ACM/Elsevier-style affiliations.
- **Added**: Rendered inline `thebibliography` / `\bibitem` references without requiring an external `.bib` file.
- **Added**: Rendered `\Abstract{...}` / `\Keywords{...}`-style journal commands in addition to environment-based abstracts and keywords.
- **Changed**: Replaced the old `metadata.fields` path with a structured metadata model and updated maketitle rendering to show authors, email markers, affiliations, and custom editor metadata.
- **Changed**: Unified metadata-sensitive refreshes with block dependency fingerprints so unchanged source blocks can still update when their declared metadata or citation dependencies change.
- **Changed**: Improved protected HTML handling for inline LaTeX styles so long colored or old-style styled groups can preserve paragraph breaks without leaking raw tokens.
- **Changed**: Improved splitter recovery for long TikZ, bibliography, resizebox, color, and old-style text declaration groups while keeping normal command handling in render rules.
- **Changed**: Tightened renderer payload typing, dependency summaries, block hash handling, and virtualized dirty-block replacement while preserving the fixed full-update threshold.
- **Changed**: Continued simplifying rendering, table, TikZ, webview, and test code by removing redundant helpers, stale tests, and low-value implementation-detail assertions.

## [0.6.2] - 2026-06-06
- **Added**: Generalized LaTeX table rendering with richer `tabular`, `tabular*`, and `tabularx` parsing, including nested tabular cells, `\multicolumn`, `\multirow`, `\makecell`, `\tnote`, `tablenotes`, booktabs-style rules, and literal escaped braces such as `\{22, 9\}`.
- **Fixed**: Prevented protected space tokens from leaking into nested table math by letting table rendering handle text-mode `~` spacing before global protection runs.
- **Fixed**: Hid `\bibliographystyle{...}` control commands from the preview while preserving `\bibliography{...}` rendering.
- **Added**: Added a richer `demo/main.tex` showcase with figures, references, algorithms, TikZ, bibliography, and a complex table exercising the table-preview features.
- **Changed**: Excluded README demo GIFs from VSIX packages while keeping them available for GitHub README rendering.

## [0.6.1] - 2026-06-04
- **Added**: Rendered `\href{url}{text}` and `\url{url}` as protected external links, with unsafe protocols downgraded to escaped plain text.

## [0.6.0] - 2026-06-04
- **Highlights**: Added default low-memory virtual mode for long documents, on-demand block HTML loading, smoother editor/preview sync, more reliable TikZ rendering, lazy PDF canvas rendering/release, stronger HTML protection, and a much broader automated test suite.
- **Highlights**: Split the webview runtime into bundled modules and moved the renderer toward span/hash-backed block snapshots, reducing duplicated source text, full HTML payloads, and unnecessary DOM replacement.
- **Fixed**: Corrected renderer block structure issues, including nested `.latex-block` output in floats, TikZ block splitting at blank lines, protected final environment flushing, starred float numbering, preprocess rule priority ordering, spaced `\label {key}` parsing, and URI normalization for remote paths.
- **Fixed**: Prevented standalone TikZ files included via `\input` inside figures from leaking their wrapper preamble/body delimiters, truncating the root document at the included `\end{document}`, or rendering macro definitions as source.
- **Fixed**: Kept long `tikzpicture` blocks and their surrounding figure/resizebox wrapper from triggering the splitter emergency line-limit recovery, preventing large TikZ figures from being split and shown as raw source.
- **Fixed**: Dropped comment-only blocks and standalone comment lines from preview rendering so long commented-out LaTeX sections no longer create large blank gaps.
- **Fixed**: Dropped standalone list boundary blocks, such as an isolated `\end{itemize}`, so blank lines around list endings no longer create empty preview blocks.
- **Fixed**: Rendered `tabularx` tables with booktabs-style rules and colored captions instead of producing an empty table body.
- **Security**: Hardened preview sync/PDF request handling and escaped `\maketitle` title, author, and date metadata before inserting it into webview HTML.
- **Added**: Expanded the core test suite for diffing, splitting, counters, BibTeX parsing, metadata extraction, protection tokens, URI normalization, renderer behavior, PDF request validation, TikZ loading, and long-document smoke coverage.
- **Added**: Memory instrumentation and update coalescing for extension-host rendering and webview DOM/PDF/TikZ stats.
- **Changed**: Switched PDF rendering to a URI-only pipeline with PDF.js URL loading, non-streaming webview resource requests, a real blob module worker, viewport-near lazy rendering, and far-offscreen canvas bitmap release.
- **Changed**: Reworked TikZ rendering to lazy-load TikZJax, bootstrap worker assets through blob URLs, cache runtime resources for the webview session, prune unused TikZ libraries per picture, preserve stale SVGs while rerendering, surface compile failures cleanly, add watchdogs, and coalesce edit-triggered render batches.
- **Changed**: Improved full-update behavior with block text hashes, block-list full payloads, per-block path fixing, and DOM preservation for unchanged blocks while keeping the existing fixed full-update threshold.
- **Added**: Implemented shell-based virtual mode behind `snaptex.virtualMode`, including shell placeholders, measured/estimated block heights, viewport-near mounting, far-offscreen unmounting, and editor-to-preview sync through shells.
- **Changed**: Made virtual mode the default low-memory preview path controlled by `snaptex.virtualMode`.
- **Fixed**: Restored `\ref`/citation anchor jumps and hover tooltips under virtual mode by indexing anchors on block shells and mounting the target block on demand.
- **Fixed**: Stabilized forward sync under virtual mode by mounting the target block before scrolling and cancelling stale auto-sync timers.
- **Changed**: Replaced fragile manual `scrollY` compensation in virtual mode with a larger directional preload window and delayed cleanup of far-offscreen mounted blocks, making upward scrolling smoother while preserving most memory savings.
- **Changed**: Kept only above-viewport virtualized shells height-locked during hydration, while visible mounted shells release estimated heights so real DOM controls spacing between visible blocks.
- **Changed**: Smoothed editor-to-preview auto-scroll by skipping layout waits for already mounted targets and reducing the small-distance skip threshold.
- **Changed**: Simplified virtual shell mounting by removing an obsolete height-update option and added webview-side hash checks before caching on-demand block HTML.
- **Changed**: Simplified extension-host update posting by using one shared path for block path rewriting and webview update messages.
- **Changed**: Virtualized full updates can now send block metadata first and request block HTML on demand only when a shell needs to mount, reducing initial DOM/HTML/PDF/TikZ memory for long previews while keeping the existing non-virtualized payload paths as fallbacks.
- **Changed**: Disabled `content-visibility:auto` inside virtualized block shells so mounted blocks report real heights while non-virtualized previews keep the existing browser lazy-layout optimization.
- **Changed**: Introduced a narrow `RenderContext` for preprocess rules so rule code no longer depends on the concrete `SmartRenderer` class.
- **Changed**: Moved the webview runtime out of `media/webview.html` into bundled webview scripts, leaving the HTML file as a small shell.
- **Changed**: Cleaned up source comments so the main classes and modules now document their architectural roles rather than development history.

## [0.5.13] - 2026-05-14
- **Added**: clean_layout_cmds rule to preprocess layout commands and no-indent markers
- **Enhanced**: thm/defi/assu/prop/... environments handling with dynamic counter management
- **Fixed**: texttt rendering and solving title meta info leakage

## [0.5.12] - 2026-04-29

- **Fixed**: Match {figure*} and {algorithm*}
- **Optim**: Memory efficient flatten lines in multiple docs

## [0.5.11] - 2026-03-26
- **Fixed**: Improved scrollbar usability in tooltips by increasing the clickable area and preventing overlap with resize handles.

## [0.5.10] - 2026-03-02
- **Fixed**: png and jpg display;
- **Fixed**: figure display in tooltips
- **Fixed**: jump for equation href
- **Added**: pin and close buttons, resize draggers for tooltips;
- **Added**: multiple tooltips panels support;
- **Added**: Support tikz;
- **Added**: Color box for theorem, lemma, ...
- **Added**: Support math and `\today` in `\maketitle`

## [0.5.9] - 2026-01-26
- **Fixed**: cross-ref of figures tables algorithms
- **Added**: General protection toolkit in rules, which replace the old env-specific protections;

## [0.5.8] - 2026-01-26
- **Fixed**: update when edit subfile
- **Added**: delay a while for tooltip panel

## [0.5.7] - 2026-01-26
- **Fixed**: forward sync fail for multi-file document (Remove the root file checker);

## [0.5.6] - 2026-01-26
- **Added**: tooltip preview panel on hover for cross-refs.
- **Added**: command `snaptex.toggleAutoScroll`, with a default keyboard shortcut `ctrl+alt+a`

## [0.5.5] - 2026-01-11
- **Fixed**: unified autoScroll uri formatter across platforms
- **Feature**: Full support vscode.dev

## [0.5.4] - 2026-01-11
- **Fixed**: autoScroll fails for web version
- **Added**: button to start preview

## [0.5.3] - 2026-01-09
- **Fixed**: webview async image canvas func load

## [0.5.2] - 2026-01-09
- **Fixed**: image 401 error

## [0.5.1] - 2026-01-09
- **Fixed**: support uri path

## [0.5.0] - 2026-01-09
- **Code reconstruction**: Remove node.js and path dependence.

## [0.4.0] - 2025-12-27
- **Code reconstruction**: Based on the Model-View-Controller guidance. Better way to avoid auto-sync jittering.

## [0.3.5] - 2025-12-27
### Added
- **AutoScroll**: Auto scrolling like markdown previewers with accurate localization.

## [0.3.4] - 2025-12-26
### Changed
- Support input and include multi-files;
- Config options:
    - `snaptex.livePreview` controls render lively or on-save;
    - `snaptex.delay` controls the delay of live render;
    - `snaptex.renderOnSwitch` controls whether automatically renders the new file when switching editor tabs

## [0.3.3] - 2025-12-26
### Changed
- **maketitle**: Support date in maketitle
- **table, figure**: If the figure/table fails to render (e.g., currently tikz is not supported), then present the raw content.
- **captions**: fixed rendering error when caption content is nested with `{}`, e.g., `\\textbf{}` in captions.

## [0.3.2] - 2025-12-25
### Changed
- **Citations**: Support cite with content like `\citep[content]{key}`

## [0.3.1] - 2025-12-25
### Changed
- **Fixed in label scanning:** Label in Nested Envs fails to be found.

## [0.3.0] - 2025-12-24
### Added
- **Citations**: Support dynamic BibTeX bibliography rendering with author-year cites and cross-refs, in plain styles and rendering rules for snap preview.

## [0.2.1] - 2025-12-23
### Fixed
- `\ref`, `\mbox` in math envs.
- The usage of quotes ``'' in TeX.

## [0.2.0] - 2025-12-23
### Added
- **Handling numbering and cross-ref** of equations，figures, tables, algorithms, theorems...

## [0.1.2] - 2025-12-23
### Changed
- **Improve the logic of math rendering:** from CacheProtect-Restore-Render to Render-CacheProtect-Restore Architecture

## [0.1.1] - 2025-12-23
### Added
- **Add Icon**

## [0.1.0] - 2025-12-23
### Added
- **Handling figures, tables, algorithm**
- **Smooth Cursor Synchronization**: Implemented a "Flash" animation (camera-flash style) when jumping between code and preview, providing better visual cues.

### Changed
- Improved the logic for reverse synchronization to ensure more accurate positioning.

## [0.0.1] - 2025-12-20
- Initial release.
- Basic LaTeX file parsing and preview functionality.
