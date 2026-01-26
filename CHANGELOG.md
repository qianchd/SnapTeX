# Change Log

All notable changes to the "SnapTeX" extension will be documented in this file.

## [0.5.9] - 2026-01-26
- **Fix bug**: cross-ref of figures tables algorithms
- **Add**: General protection toolkit in rules, which replace the old env-specific protections;

## [0.5.8] - 2026-01-26
- **Fix bug**: update when edit subfile
- **Add**: delay a while for tooltip panel

## [0.5.7] - 2026-01-26
- **Fix bug**: forward sync fail for multi-file document (Remove the root file checker);

## [0.5.6] - 2026-01-26
- **Add**: tooltip preview panel on hover for cross-refs.
- **Add**: command `snaptex.toggleAutoScroll`, with a default keyboard shortcut `ctrl+alt+a`

## [0.5.5] - 2026-01-11
- **Fix bug**: unified autoScroll uri formatter across platforms
- **Feature**: Full support vscode.dev

## [0.5.4] - 2026-01-11
- **Fix bug**: autoScroll fails for web version
- **Add**: button to start preview

## [0.5.3] - 2026-01-09
- **Fix bug**: webview async image canvas func load

## [0.5.2] - 2026-01-09
- **Fix**: image 401 error

## [0.5.1] - 2026-01-09
- **Fix**: support uri path

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
- **Fix bug in label scanning:** Label in Nested Envs fails to be found.

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