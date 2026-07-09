# SnapTeX AST Pipeline

SnapTeX now has two preview backends:

* `legacy`: the default stable path.
* `ast(experimental)`: an opt-in backend that uses AST structure for splitting,
  compact block artifacts, dependency summaries, block rendering, and
  source-sync hints.

Both backends still share the same `LatexDocument` source map, `SmartRenderer`
diff/lazy payload contract, preview virtualization, TikZ/PDF resource lifecycle,
and host-driven editor-preview sync.

## Production Flow

1. `LatexDocument.parse()` flattens the root document and included files.
2. Metadata, macros, bibliography data, block spans, hashes, and source maps are
   produced from that flattened body text.
3. In AST mode, `src/ast/splitter.ts` refines legacy coarse spans with local AST
   structure and `src/ast/block-metadata.ts` stores compact artifacts by block
   hash.
4. `SmartRenderer.renderAsync()` uses AST artifacts and registry-provided AST
   render rules while preserving the existing full/patch payload contract.
   Production numbering still uses `LatexCounterScanner`.
5. The preview runtime receives the same block metadata and lazy HTML requests
   as legacy mode.

## AST Modules

* `src/ast/parse.ts`: safe async unified-latex parser wrapper.
* `src/ast/visit-utils.ts`: local node readers for macros, environments,
  arguments, comments, source positions, and verbatim-like nodes.
* `src/ast/splitter.ts`: two-layer splitter using legacy coarse spans plus local
  AST refinement for transparent containers and decorator groups.
* `src/ast/block-metadata.ts`: compact labels, citations, environments,
  macros, and source hints for math, refs, citations, sections, and list items.
* `src/ast/scanner.ts`: tested AST counter and label scanner kept for
  validation and future background correction work; production numbering still
  uses `LatexCounterScanner`.
* `src/ast/rules/*`: AST render rules. The production entry point is
  `RuleRegistry.astRenderRules`.
* `src/ast/renderer.ts`: per-block AST renderer used by `SmartRenderer` in AST
  mode.
* `src/ast/benchmark.ts`: benchmark utility for split, artifacts, render, and
  heap measurements.

## Storage Rule

AST mode does not retain full AST trees for every block. Durable state is still
block spans, hashes, compact artifacts, and source maps. Full ASTs are transient
while refining a span, extracting an artifact, scanning a block, or rendering a
lazy block.

## Known Limits

`legacy` remains the default. AST mode is opt-in until real preview validation
covers long malformed documents, TikZ/PDF/image-heavy scrolling, virtualized DOM
mount counts, and more user documents.
