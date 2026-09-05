# Settings Reference

Most settings apply while the preview is open. Settings that change document or DOM ownership trigger or require a full lifecycle reload, as noted below.

## VS Code settings

| Setting | Default | Effect |
| --- | --- | --- |
| `snaptex.livePreview` | `true` | Update while typing. When disabled, update on save. |
| `snaptex.delay` | `100` ms | Debounce delay for document updates. |
| `snaptex.renderOnSwitch` | `false` | Follow newly selected editor tabs automatically. |
| `snaptex.autoScrollSync` | `true` | Enable cursor and scroll synchronization. |
| `snaptex.autoScrollDelay` | `100` ms | Delay for automatic sync events. |
| `snaptex.debugMemory` | `false` | Log memory and heavy-resource diagnostics. |
| `snaptex.retainContextWhenHidden` | `false` | Keep the webview alive while its tab is hidden. |
| `snaptex.virtualMode` | `true` | Mount only viewport-near block DOM. Reopen or reload the preview after changing it. |
| `snaptex.backendMode` | `legacy` | Select `legacy` or `ast(experimental)` processing. |
| `snaptex.previewLayout` | `paged` | Select an elastic paged preview or a continuous document. |
| `snaptex.previewFontSize` | `2.8cqw` | Set preview text size with any valid CSS `font-size` value. |
| `snaptex.previewLineHeight` | `1.25` | Set preview line spacing with any valid CSS `line-height` value. |
| `snaptex.previewContentMaxWidth` | `3000px` | Limit the continuous content or paged-page width with any valid CSS `max-width` value. |
| `snaptex.previewFontFamily` | Times-style serif stack | Set the CSS font family used by preview text. |

Container-relative font units such as `cqw` use the rendered content width in continuous mode and the centered paper width in paged mode, rather than the full preview-panel width.

## Which settings reload the preview

| Setting type | Behavior |
| --- | --- |
| `backendMode` | SnapTeX performs a full root reload so block spans, artifacts, rules, and source maps come from one backend |
| `virtualMode` | Reopen or reload the preview so DOM ownership switches cleanly |
| `previewLayout` | Applies immediately without reparsing the document |
| Preview typography and content width | Apply immediately, keep rendered block HTML, and recalculate layout-dependent height data |
| Live preview, delays, auto sync, memory logging | Apply to subsequent events without rebuilding document structure |
| `retainContextWhenHidden` | Affects the next hidden/shown webview lifecycle |

## Web settings

The Web settings menu exposes the host-independent subset:

- Explorer and diagnostics visibility;
- live preview;
- automatic scroll sync;
- virtual mode;
- memory diagnostics;
- backend mode;
- continuous or paged preview layout;
- render and sync delays;
- preview font size, line height, content width, and font family;
- editor font size and font family;
- light, dark, blue, and rose themes.

All Web settings listed above are stored for the current Web origin and reused across projects and browser restarts. This includes behavior switches, delays, backend and layout mode, theme, panel and diagnostics visibility, and editor and preview typography. The same saved values therefore apply on mobile and desktop when they use the same browser profile and origin.

Private browsing, clearing site data, or opening a different origin/browser profile starts from the defaults. Project contents remain stored by the selected project backend, independently of these preferences. VS Code settings use VS Code configuration and are not shared with the Web app.

## Backend mode

`legacy` is the stable default. `ast(experimental)` adds AST-assisted splitting, rule metadata, dependencies, rendering, and source hints while retaining the same preview protocol, lazy loading, and virtualization runtime.

Changing backend mode forces a full document reload so block boundaries, numbering, dependencies, and source maps cannot mix between backends.

## Preview layout

`continuous` keeps the existing uninterrupted preview. `paged` draws page-like backgrounds around the same rendered block DOM, so patch updates, virtual mode, source synchronization, TikZ, and PDF rendering continue to use their existing paths.

Page bottoms are elastic: small edits first consume or release bottom whitespace instead of moving later blocks between pages. A block is never split by the page layout. When a proof, styled group, table, figure, TikZ diagram, PDF, or other block is taller than a normal page, SnapTeX gives that block one extended-height page.
