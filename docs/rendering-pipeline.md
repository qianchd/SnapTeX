# SnapTeX Rendering Pipeline

This document summarizes the production preview path shared by the VS Code,
standalone web, and future hosts.

## Shared Flow

1. `LatexDocument.parse()` resolves the root document, included files, metadata,
   macros, bibliography data, flattened body text, block spans, hashes, and
   source maps.
2. `DiffEngine` compares block hashes to decide full render versus localized
   patch render.
3. `SmartRenderer` scans numbering, collects dependency fingerprints, renders
   changed or requested blocks, and returns full or patch payloads.
4. The preview runtime applies payloads, keeps block shells in virtual mode, and
   requests lazy block HTML when a shell needs to mount.

## Backend Split

`legacy` mode uses:

* `LatexBlockSplitter`;
* `LatexCounterScanner`;
* registry `renderRules`;
* Markdown-it plus `ProtectionManager`.

`ast(experimental)` mode uses:

* the AST-assisted two-layer splitter;
* compact AST block artifacts;
* `LatexCounterScanner` for production numbering;
* registry `astRenderRules`;
* AST source hints for intra-block sync refinement.

The two modes intentionally share the same block hash diffing, source-map
ownership, lazy HTML request path, preview message contract, and virtualization
runtime.

## Lazy Rendering

When `deferFullHtml` is enabled, the renderer sends block metadata first and
keeps a text snapshot for later `renderBlockByIndex(index)` requests. AST mode
uses the async `renderBlockByIndexAsync(index)` wrapper so lazy blocks still use
the selected backend.

## Protected HTML

Legacy rules that generate trusted HTML call `RenderContext.protectHtml()` so
Markdown-it cannot escape generated KaTeX, refs, tables, TikZ placeholders, and
metadata HTML. AST rules render structured HTML directly and rely on their
context hooks for escaping, math, refs, citations, images, and labels.
