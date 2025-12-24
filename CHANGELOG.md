# Change Log

All notable changes to the "SnapTeX" extension will be documented in this file.

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