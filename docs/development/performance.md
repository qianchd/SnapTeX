# Performance

Read this page when a change affects initial-load latency, heap growth, mounted DOM, layout stability, or heavy resources. Measure the owning layer before optimizing: extension/host heap, serialized payload, and browser DOM/resource memory are different costs.

## Memory model

SnapTeX's largest avoidable costs are full source duplication, serialized block HTML, mounted DOM, PDF canvases, and TikZ runtimes. The current model limits each one:

- source text is stored once and blocks keep spans;
- renderer snapshots keep hashes and metadata rather than full block strings;
- virtual mode mounts only viewport-near HTML;
- block HTML is requested on demand and released after a retention window;
- PDF canvases and TikZ output follow block resource lifetimes.

## Diffing

Every block receives a stable hash of its source text. Prefix/suffix comparison and block hashes find changed ranges without comparing long `outerHTML` strings. Dependency fingerprints add non-source invalidation for title metadata and bibliography state.

## Scanner summaries

The scanner caches block-local tokens by source hash, so unchanged blocks do not repeat their regular-expression scan. It then walks those compact summaries in document order to rebuild counters and labels. User-defined counter redefinitions are intentionally outside the simple numbering model, except for supported explicit tags.

## Virtual layout

Shells carry estimated heights. Mounted blocks report real heights. For blocks inserted above the viewport, the runtime applies height changes and scroll compensation in the same frame so the visible content does not make a two-step jump.

Viewport-near work is expressed relative to viewport height rather than fixed screen pixels, making behavior more consistent across displays.

## AST cost control

The AST backend does not retain a complete document tree indefinitely. It refines coarse blocks and stores compact artifacts. Background warm-up fills missing artifacts without blocking initial visible rendering.

## Measuring

Use production builds when comparing memory or startup behavior. Development source maps, browser devtools, logging, and test extension hosts add significant baseline memory.

For VS Code, enable `snaptex.debugMemory`; for Web, enable **Debug memory** in Settings. Compare:

- extension/host heap;
- total shells and mounted blocks;
- cached HTML count;
- PDF canvases;
- active and cached TikZ output.

Change one lifetime or representation at a time and compare the same document, viewport, backend, and production build. A lower stable heap can still hide a higher opening peak, so record both peak and settled measurements.
