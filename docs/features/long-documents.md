# Long Documents

SnapTeX is designed to keep large previews usable without holding the complete rendered document in the DOM.

## Block model

The document body is stored once. Blocks are represented by source spans, line metadata, stable source hashes, dependency fingerprints, and optional compact AST hints. Rendering reads block text from the source span only when needed.

On edits, unchanged hashes retain their existing HTML and heavy resources. The renderer patches changed ranges rather than rebuilding the complete page, except when the established full-update threshold is exceeded.

## Virtual mode

With `snaptex.virtualMode` enabled, the webview creates lightweight shells for every block but mounts real block HTML only near the viewport. Shell heights preserve scrollbar length.

When a mounted block's actual height differs from its shell estimate, layout and scroll compensation are applied in the same frame. Heavy asynchronous content reports later height changes through the same compensation path.

## On-demand HTML

The extension host can initially send block metadata without serializing all HTML. The webview requests HTML when a block enters the mount range, a reference or tooltip needs it, or a sync target must be revealed.

Released HTML is cached for a bounded period so a short reverse scroll does not immediately request and render the same block again. Tooltip users are counted before cached content is released.

## Heavy resources

- Images use browser-native lazy decoding where practical.
- PDF canvases render near the viewport and are released when far away.
- TikZJax loads only after a mounted block contains TikZ.
- Revisited TikZ source can reuse cached SVG output.

## Memory diagnostics

Enable `snaptex.debugMemory` to log extension-host memory together with webview block, DOM, PDF, and TikZ statistics. Use this only for diagnosis; repeated logging adds noise and a small amount of work.

## Retain context when hidden

`snaptex.retainContextWhenHidden` keeps the VS Code webview alive after its tab is hidden. It improves instant tab return but retains the webview's DOM and runtime memory. Keep it disabled when memory use matters more than hidden-tab responsiveness.
