# SnapTeX Web/Standalone Roadmap

This file tracks the current migration from a VS Code-only extension to a shared SnapTeX core with browser and future Android hosts. It intentionally focuses on the next executable milestones instead of preserving old historical checklist noise.

## Principles

- Keep the VS Code extension working while web/standalone evolves.
- Keep `src/` host-neutral: no runtime dependency on `vscode`.
- Keep browser preview runtime DOM-based but VS Code webview-independent.
- Put VS Code-specific code under `apps/vscode`.
- Put shared browser/editor host code under `apps/standalone`.
- Put desktop browser shell code under `apps/web`.
- Prefer narrow host interfaces over broad platform abstractions.
- Avoid compatibility shims unless they are actively needed.
- Commit each coherent working step after tests pass.

## Current Baseline

- [x] VS Code host code lives in `apps/vscode/src`.
- [x] Shared parser/renderer/update pipeline is usable outside VS Code.
- [x] Shared preview runtime uses a host bridge instead of direct `acquireVsCodeApi()`.
- [x] Shared preview HTML template is host-filled.
- [x] Browser `FileProvider` supports lazy text reads and blob resource URLs.
- [x] Web shell can open a single TeX file or project folder.
- [x] Web shell can render text, math, images, PDF placeholders, and TikZ.
- [x] Web shell has a real TikZJax asset smoke test.
- [x] Web shell has a minimal multi-file editing loop.

## Milestone 1: Web Project Editing Loop

Goal: make `apps/web` useful for a normal multi-file LaTeX project while keeping preview rooted at the selected main TeX file.

- [x] Track two file roles explicitly:
  - [x] `rootPath`: document used for preview rendering.
  - [x] `activePath`: file currently loaded in CodeMirror.
- [x] Save editor text into the browser file provider before switching active files.
- [x] When editing an included file, render preview from `rootPath`, not `activePath`.
- [x] Add a minimal file list for project text files:
  - [x] `.tex`
  - [x] `.bib`
  - [x] `.sty`
  - [x] `.cls`
  - [x] `.bst`
  - [x] `.txt`
- [x] Highlight the active file and indicate the preview root.
- [x] Save the active file, with download fallback when direct write is unavailable.
- [x] Keep all project text reads lazy except the active file opened into the editor.
- [x] Add focused tests for root/active switching and lazy included-file rendering.

## Milestone 2: Web Project Usability

- [x] Allow choosing/changing the preview root from the file list.
- [x] Track dirty state per active file at minimum.
- [ ] Confirm project reload does not keep stale object URLs or stale text cache.
- [ ] Surface missing `\input`, missing image/PDF, and missing bibliography errors in a readable status area.
- [ ] Add a small manual smoke fixture under `demo/` for multi-file project editing.

## Milestone 3: Editor And Preview Sync

- [ ] Implement forward sync from CodeMirror cursor to preview.
- [ ] Implement reverse sync from preview double-click to CodeMirror.
- [ ] Reuse existing source-map data instead of adding web-only mapping logic.
- [ ] Avoid scroll feedback loops between editor and preview.
- [ ] Add minimal tests around message routing and source-map lookup where practical.

## Milestone 4: CodeMirror Assistance

- [ ] Dynamic label completions for `\ref` and `\eqref`.
- [ ] Dynamic citation-key completions for cite commands.
- [ ] Project-file completions for `\input`, `\include`, and `\includegraphics`.
- [ ] User macro hints from parsed metadata.
- [ ] Keep completions optional and derived from existing parse metadata.

## Milestone 5: Build Boundary Cleanup

- [ ] Split `esbuild.js` responsibilities into small functions:
  - [ ] extension bundle
  - [ ] preview runtime bundles
  - [ ] web app bundle
  - [ ] vendor asset copy/patch
- [ ] Keep generated bundles ignored/generated.
- [ ] Preserve TikZJax patching and copied `tex_files/*.gz`.
- [ ] Avoid npm workspaces until source boundaries are stable.

## Milestone 6: Android Preparation

- [ ] Reuse `apps/standalone` for Android WebView.
- [ ] Use Android asset loading for bundled runtime/vendor assets.
- [ ] Evaluate `WebViewAssetLoader` before adding any local HTTP server.
- [ ] Add Storage Access Framework file-provider support.
- [ ] Keep virtual mode, lazy PDF, lazy TikZJax, and bounded caches enabled by default.

## Verification

- [ ] `npm run check-types`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] Manual VS Code smoke:
  - [ ] long document
  - [ ] virtual mode
  - [ ] TikZ
  - [ ] PDF/image
  - [ ] references/tooltips
- [ ] Manual web smoke:
  - [ ] open folder
  - [ ] switch files
  - [ ] edit included TeX file and see root preview update
  - [ ] image/PDF/TikZ resources
