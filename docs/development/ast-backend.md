# AST Backend

The `ast(experimental)` backend augments the existing document and preview pipeline. It is not a second UI, message protocol, virtualization system, or file-access implementation.

Read this page when changing AST refinement, artifacts, source hints, or AST render rules. First read the shared [Rendering Pipeline](./rendering-pipeline.md); everything below plugs into that lifecycle rather than replacing it.

## Split strategy

SnapTeX keeps two block levels:

1. the proven coarse splitter establishes memory-safe source ranges;
2. AST refinement analyzes long or structurally rich coarse blocks and can split internal semantic content without treating styles such as `{\color{...} ...}` as one indivisible block.

This preserves bounded memory behavior while using AST structure for nested environments, lists, math, styles, and source hints.

## Artifacts and warm-up

Blocks can carry compact `AstBlockArtifact` data:

- root node kind;
- recognized macros and environments;
- source-span hints;
- paragraph and inline math ranges;
- metadata used by dependency and rendering rules.

The initial path parses artifacts needed for structurally long blocks. Visible blocks gain artifacts during normal rendering; remaining blocks gain them as the background height pass requests their lazy HTML. Rendering and hint extraction share that AST parse, so initial pagination does not run a second document-wide artifact parser.

Dynamic source updates regenerate artifacts for affected blocks. Navigation reads stored hints; it does not run a new AST parse for every sync request. Renderer snapshots may reuse an artifact's label and citation arrays directly; artifact metadata must therefore be treated as immutable after publication.

## AST rules

AST rules match node structure rather than competing regular-expression priority alone. They improve nested command arguments, headings with math, list ownership, captions at arbitrary child positions, and inline source spans.

Content not claimed by an AST rule uses the AST fallback renderer for comments, whitespace, paragraphs, ordinary text, unsupported macros, and child arrays. Built-in AST rules deliberately reuse host-neutral helpers such as KaTeX, citations, tables, and TikZ preparation where those services are shared; the block is not rerun through the legacy `renderRules` pipeline.

## Scanner status

An AST scanner implementation exists and has been compared with the legacy scanner, but the production pipeline continues to use the lighter block-summary scanner. Numbering is inherently ordered, while AST warm-up can be non-linear; reparsing all blocks only to replace a working scanner would increase startup cost without a matching user benefit.

## Backend switch

Changing backend mode performs a complete document reload. Mixing legacy block boundaries with AST artifacts or source maps from the previous lifecycle is not supported.

## Related extension APIs

- Use the [AST rule contract](../extending/api/contracts/ast-rules.md) to add node rendering behavior.
- Use the [splitter contract](../extending/api/contracts/splitter.md) when AST refinement receives an unsuitable coarse block.
- Use [Sync Model](./sync-model.md) to understand how stored source hints improve navigation without reparsing during each sync.
