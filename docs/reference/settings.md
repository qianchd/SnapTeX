# Settings Reference

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

## Web settings

The Web settings menu exposes the host-independent subset:

- Explorer and diagnostics visibility;
- live preview;
- automatic scroll sync;
- virtual mode;
- memory diagnostics;
- backend mode;
- render and sync delays;
- light, dark, blue, and rose themes.

Web settings apply to the current application session. Project contents are stored by the selected project backend, independently of display settings.

## Backend mode

`legacy` is the stable default. `ast(experimental)` adds AST-assisted splitting, rule metadata, dependencies, rendering, and source hints while retaining the same preview protocol, lazy loading, and virtualization runtime.

Changing backend mode forces a full document reload so block boundaries, numbering, dependencies, and source maps cannot mix between backends.
