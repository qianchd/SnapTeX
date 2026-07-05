# SnapTeX Standalone/Web/Android Refactor Plan

This plan replaces the old working todo list. The goal is to make SnapTeX reusable outside VS Code while keeping the VS Code extension stable during the transition.

## Guiding Principles

- [ ] Keep the current VS Code extension working throughout the refactor.
- [ ] Move the VS Code host layer out after the host-agnostic interfaces are stable; defer the larger package split.
- [ ] Keep `dev` as the integration branch for this large refactor; merge back to `master` only after a coherent milestone is stable.
- [ ] Make `core` independent from VS Code and DOM APIs.
- [ ] Make the preview runtime depend on browser DOM APIs, but not on VS Code webview APIs.
- [ ] Share one preview HTML template across VS Code, Web, and Android hosts.
- [ ] Let each host provide its own file access, resource URLs, settings, and bridge implementation.
- [ ] Keep generated bundles and vendor artifacts out of source-level refactor commits unless the build intentionally changes them.
- [ ] Commit each coherent step separately after tests pass.
- [ ] Prefer small adapter interfaces over broad "platform" abstractions.

## Target Architecture

```text
snaptex/
  packages/
    core/               # LaTeX parse/render/rules/scanner/splitter/bib/table
    preview-runtime/    # DOM preview, virtualization, PDF.js, TikZJax, tooltips
  apps/
    vscode/             # VS Code extension host
    standalone/         # Shared browser/WebView client with CodeMirror
    web/                # Desktop browser shell
    android/            # Android WebView wrapper
```

Do not move to this final layout immediately. The current milestone is narrower:

```text
snaptex/
  apps/
    vscode/src/       # VS Code extension host only
    standalone/src/   # Browser/WebView shared client
    web/              # Desktop browser shell
  src/                # host-neutral core plus browser preview runtime
```

After this milestone, no runtime file under `src/` should import `vscode`. The later `packages/core` and
`packages/preview-runtime` split should be a directory/package migration, not another behavior rewrite.

## Current Boundary Issues

- [x] `src/document.ts` no longer imports `vscode` for URI types.
- [x] `src/file-provider.ts` holds only the generic file-provider interface.
- [x] `src/utils.ts` no longer imports `vscode` for URI helper typing.
- [x] Shared parse/render/update orchestration lives in `src/preview-update-service.ts`.
- [x] `src/webview/main.ts` and `src/webview/pdf.ts` use the preview bridge instead of direct `vscode.postMessage(...)`.
- [x] `media/webview.html` is a shared template with host-provided CSP, styles, data, and scripts.
- [x] Move `src/extension.ts`, `src/panel.ts`, and `src/vscode-file-provider.ts` into `apps/vscode/src`.
- [ ] Keep VS Code image/PDF path rewriting in the VS Code host layer until a future `ResourceResolver` is introduced.
- [ ] Keep root `package.json`, `.vscodeignore`, and VSIX packaging in place until the extension package itself moves.

## Host Boundary Contract

The shared code should eventually depend only on these host-provided capabilities:

- [ ] `FileProvider`: read text, test existence, stat mtime/version, resolve relative paths, and get parent directory.
- [ ] `ResourceResolver`: turn document-relative image/PDF/vendor paths into safe browser URLs.
- [ ] `PreviewBridge`: pass typed messages between host and preview runtime.
- [ ] `ConfigProvider`: provide live preview delay, auto-scroll, debug memory, virtual mode, and host-specific feature flags.
- [ ] `EditorSyncAdapter`: map editor cursor/scroll events to preview sync and preview reverse sync back to the editor.
- [ ] `LifecycleAdapter`: handle startup, reload, hidden/visible state, cleanup, and disposal.
- [ ] Keep the host interfaces narrow enough that VS Code, Web, and Android can implement them without platform-specific branches in core.

## Phase 1: Shared Preview HTML Template

- [x] Keep HTML as HTML, not as a large TypeScript string.
- [x] Convert `media/webview.html` into a host-neutral template, or add `media/preview-template.html`.
- [x] Add a small TypeScript helper that fills template placeholders.
- [x] The helper should only handle escaping and placeholder replacement.
- [x] Escape attribute values and URLs before inserting them into the template.
- [x] Assert that generated HTML contains no unreplaced `{{...}}` placeholders.
- [ ] The template should contain placeholders such as:
  - [x] `{{cspMeta}}`
  - [x] `{{styleLinks}}`
  - [x] `{{bodyData}}`
  - [x] `{{bridgeScript}}`
  - [x] `{{scripts}}`
- [x] VS Code should pass:
  - [x] VS Code CSP meta tag
  - [x] `webview.asWebviewUri(...)` style/script/resource URLs
  - [x] TikZJax and PDF.js data attributes
- [ ] Future Web/Android hosts should pass ordinary browser or app-asset URLs.
- [x] Keep CSP host-specific. Do not force VS Code's CSP into the standalone web or Android shells.
- [x] Keep the template compatible with both inline-free scripts and the current VS Code webview constraints.
- [x] Test that the generated VS Code webview HTML still contains the expected CSP, resource URLs, and runtime scripts.
- [x] Test that template escaping prevents malformed attributes when URLs contain `&`, `"`, or spaces.

## Phase 2: Preview Bridge

- [x] Introduce a small preview bridge interface for webview-to-host communication.
- [x] Replace direct `acquireVsCodeApi()` usage in preview runtime with the bridge.
- [x] Keep the existing message contract in `src/webview-messages.ts`.
- [x] Add a VS Code bridge implementation that wraps `acquireVsCodeApi()`.
- [x] Leave room for a future browser bridge that calls an in-page `BrowserHost`.
- [x] Ensure the bridge is installed before `webview-main.js` and `webview-pdf.js` run.
- [x] Add minimal browser/global typings for `window.snaptexPreviewBridge` and existing SnapTeX globals.
- [x] Define a clear failure mode when the bridge is missing, instead of throwing a cryptic `acquireVsCodeApi` error.
- [x] Keep PDF and block-HTML requests routed through the same bridge contract, not special global callbacks.
- [ ] Confirm these messages still work:
  - [x] `webviewLoaded`
  - [x] `requestBlockHtml`
  - [x] `requestPdf`
  - [x] `syncScroll`
  - [x] `revealLine`
- [x] Test that webview message validation and preview startup still work.

## Phase 3: Host-Agnostic File Provider

- [x] Split the generic file-provider interface from the VS Code implementation.
- [x] Make the interface use a host-agnostic URI type, such as `UriLike` or a generic parameter.
- [x] Keep `VscodeFileProvider` as the VS Code-specific implementation.
- [x] Add a browser-oriented interface shape for `BrowserFileProvider`.
- [x] Implement the first browser file provider after the interface stabilized.
- [x] Preserve VS Code dirty-editor reads before disk reads.
- [x] Define how file versions/mtimes work for browser-uploaded files that do not have stable filesystem mtimes.
- [ ] Decide whether binary assets are handled by `FileProvider`, `ResourceResolver`, or a separate asset provider.
- [ ] Normalize document-relative paths consistently across Windows, browser virtual paths, and Android document URIs.
- [ ] Keep source-map file identities stable enough for forward and reverse sync.
- [x] Test current VS Code parsing, `\input`, inline TikZ input, and `.bib` loading.

## Phase 4: Remove VS Code Types From Core

- [x] Remove direct `vscode` imports from `src/document.ts`.
- [x] Remove direct `vscode` imports from core parts of `src/utils.ts`.
- [x] Keep VS Code URI handling in the VS Code host layer.
- [x] Define the public core entry points that Web/Android should call.
- [x] Avoid exposing renderer internals that only VS Code currently needs.
- [x] Keep `SmartRenderer` and `LatexDocument` usable from tests without a VS Code runtime.
- [ ] Ensure `LatexDocument` still supports:
  - [x] root document parsing
  - [x] nested `\input`
  - [x] source maps
  - [x] bibliography loading
  - [x] block spans and hashes
- [x] Run full tests after this phase.

## Phase 5: VS Code Host Migration

- [x] Create `apps/vscode/src`.
- [x] Move `extension.ts`, `panel.ts`, and `vscode-file-provider.ts` into `apps/vscode/src`.
- [x] Update imports so moved VS Code host files depend on shared code through `../../../src/...`.
- [x] Update `esbuild.js` extension entry point to `apps/vscode/src/extension.ts`.
- [x] Update `tsconfig.json` so both `src` and `apps/vscode/src` compile.
- [x] Keep generated output paths unchanged: `dist/extension.js`, `media/webview-main.js`, and `media/webview-pdf.js`.
- [x] Confirm runtime files under `src/` have no direct `vscode` imports.
- [x] Run type checks, lint, and tests after the move.
- [x] Avoid behavior changes in this commit; this is a host-boundary directory migration with the preview bridge fallback moved into the VS Code host bootstrap.

## Phase 6: Build Boundary Cleanup

- [ ] Review `esbuild.js` after bridge/template changes.
- [ ] Separate concerns in the build script:
  - [ ] extension bundle
  - [ ] preview runtime bundle
  - [ ] vendor asset copy/patch
- [ ] Do not move `media/vendor` until TikZJax and PDF.js still load reliably through the new template.
- [x] Confirm generated `media/webview-main.js` and `media/webview-pdf.js` remain ignored/generated as intended.
- [x] Confirm `.vscodeignore` still includes the correct files for VSIX packaging.
- [ ] Keep root `package.json` as the VS Code extension package until moving extension packaging into `apps/vscode` is intentionally scheduled.
- [ ] Do not introduce npm workspaces until the source boundaries are stable enough to justify the package split.
- [ ] Preserve TikZJax patching and copied `tex_files/*.gz` assets during any build-path change.

## Phase 7: Standalone Browser/WebView Client

- [x] Add `apps/standalone`.
- [x] Put CodeMirror editor setup in `apps/standalone`, not directly in `apps/web`.
- [x] Implement a minimal shared `StandaloneHost`.
- [x] Implement a minimal shared `BrowserFileProvider`.
- [x] Start with a single-file `.tex` document stored in memory.
- [x] Reuse `LatexDocument`, `SmartRenderer`, `PreviewUpdateService`, and preview runtime.
- [x] Route preview messages through `window.snaptexPreviewBridge`.
- [x] Keep editor-preview sync minimal in the first pass; basic render/update is the required milestone.
- [x] Keep Android-specific file permissions and asset loading out of this layer.
- [ ] Then add:
  - [x] project folder loading
  - [ ] zip loading
  - [x] `\input` for loaded project files
  - [x] `.bib` for loaded project files
  - [x] save current root file, with download fallback when direct write is unavailable
  - [ ] image/PDF blob URLs
  - [ ] TikZJax assets
  - [ ] reference/citation/tooltips
  - [ ] editor-preview sync
- [ ] Add CodeMirror dynamic completions after the basic preview works:
  - [ ] labels for `\ref` and `\eqref`
  - [ ] citation keys for `\cite` commands
  - [ ] project files for `\input` and `\includegraphics`
  - [ ] user-defined commands from metadata/macros

## Phase 8: Desktop Web Shell

- [x] Add `apps/web`.
- [x] Add a web-specific `index.html` that hosts the shared standalone client.
- [x] Use ordinary browser resource paths for KaTeX, preview CSS, PDF.js, TikZJax, and preview bundles.
- [x] Add a small dev server or documented local serve command.
- [x] Add a web smoke test once the first prototype can render a document.
- [x] Do not duplicate editor, preview, or project-state logic from `apps/standalone`.

## Phase 9: Package Directory Migration

- [ ] Only move shared directories after the VS Code host migration and standalone browser client establish stable boundaries.
- [ ] Move core files into `packages/core`.
- [ ] Move DOM preview runtime into `packages/preview-runtime`.
- [x] Move VS Code host files into `apps/vscode`.
- [ ] Keep a temporary compatibility entry point if the VS Code extension still expects root-level `src/extension.ts`.
- [ ] Keep tests close to the packages they cover.
- [ ] Update build scripts and package metadata after paths are stable.
- [ ] Update import paths mechanically and avoid behavior changes in the directory-move commit.
- [ ] Update README, CHANGELOG, and release scripts only after the new layout builds.

## Phase 10: Android Wrapper

- [ ] Reuse the standalone browser/WebView client bundle.
- [ ] Use Android WebView as the container.
- [ ] Prefer Android asset loading for bundled runtime/vendor assets.
- [ ] Evaluate WebViewAssetLoader first; only add a local HTTP server if worker/vendor loading requires it.
- [ ] Add Android file access through Storage Access Framework.
- [ ] Map Android document URIs to the same host file-provider abstraction.
- [ ] Define save behavior before exposing editing as production-ready.
- [ ] Test worker loading for PDF.js and TikZJax under Android WebView before adding complex UI.
- [ ] Keep memory settings conservative:
  - [ ] virtual mode on
  - [ ] lazy PDF rendering
  - [ ] lazy TikZJax loading
  - [ ] bounded HTML cache

## Suggested Commit Order

- [ ] `refactor: introduce shared preview html template`
- [ ] `refactor: isolate preview runtime bridge`
- [ ] `refactor: split generic file provider from vscode host`
- [ ] `refactor: remove vscode uri types from document core`
- [x] `refactor: move vscode host code into apps/vscode`
- [x] `chore: prepare standalone browser client scaffold`
- [x] `feat: add standalone web preview prototype`
- [ ] `chore: document package/app migration boundaries`

## Verification Checklist

- [ ] `npm run compile-tests`
- [x] `npm run check-types`
- [x] `npm run lint`
- [ ] `npm test`
- [ ] Template tests for VS Code HTML generation.
- [ ] Bridge tests for VS Code preview message routing.
- [ ] Core tests that import `LatexDocument` without importing `vscode`.
- [x] Web prototype smoke test once `apps/web` exists.
- [ ] Manual VS Code preview smoke test with:
  - [ ] long document
  - [ ] virtual mode
  - [ ] TikZ
  - [ ] PDF/image
  - [ ] references and tooltips
  - [ ] forward and reverse sync
- [ ] Memory smoke check for long documents after any preview-runtime change.
