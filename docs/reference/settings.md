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
| `snaptex.previewLayout` | `continuous` | Select a continuous document or an elastic paged preview. |

## Which settings reload the preview

| Setting type | Behavior |
| --- | --- |
| `backendMode` | SnapTeX performs a full root reload so block spans, artifacts, rules, and source maps come from one backend |
| `virtualMode` | Reopen or reload the preview so DOM ownership switches cleanly |
| `previewLayout` | Applies immediately without reparsing the document |
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
- light, dark, blue, and rose themes.

Web settings apply to the running application. Project contents are stored by the selected project backend, independently of display settings.

## Backend mode

`legacy` is the stable default. `ast(experimental)` adds AST-assisted splitting, rule metadata, dependencies, rendering, and source hints while retaining the same preview protocol, lazy loading, and virtualization runtime.

Changing backend mode forces a full document reload so block boundaries, numbering, dependencies, and source maps cannot mix between backends.

## Preview layout

`continuous` keeps the existing uninterrupted preview. `paged` draws page-like backgrounds around the same rendered block DOM, so patch updates, virtual mode, source synchronization, TikZ, and PDF rendering continue to use their existing paths.

Page bottoms are elastic: small edits first consume or release bottom whitespace instead of moving later blocks between pages. A block is never split by the page layout. When a proof, styled group, table, figure, TikZ diagram, PDF, or other block is taller than a normal page, SnapTeX gives that block one extended-height page.
