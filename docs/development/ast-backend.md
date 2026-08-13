# AST Backend

The `ast(experimental)` backend augments the existing document and preview pipeline. It is not a second UI, message protocol, virtualization system, or file-access implementation.

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

The initial path parses artifacts needed for visible or structurally long blocks. Remaining coarse blocks warm in the background. Warmed hints update document state and are reused by later rendering, dependency, and synchronization work.

Dynamic source updates regenerate artifacts for affected blocks. Navigation reads stored hints; it does not run a new AST parse for every sync request.

## AST rules

AST rules match node structure rather than competing regular-expression priority alone. They improve nested command arguments, headings with math, list ownership, captions at arbitrary child positions, and inline source spans.

Legacy render helpers remain the fallback for content not claimed by an AST rule. This is deliberate reuse of stable behavior, not a fallback to a separate backend pipeline.

## Scanner status

An AST scanner implementation exists and has been compared with the legacy scanner, but the production pipeline continues to use the lighter block-summary scanner. Numbering is inherently ordered, while AST warm-up can be non-linear; reparsing all blocks only to replace a working scanner would increase startup cost without a matching user benefit.

## Backend switch

Changing backend mode performs a complete document reload. Mixing legacy block boundaries with AST artifacts or source maps from the previous lifecycle is not supported.
