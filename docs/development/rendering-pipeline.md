# Rendering Pipeline

## Initial load

1. A host supplies the root URI, source text, and file provider.
2. `LatexDocument.parse()` extracts preamble metadata and expands supported included source.
3. The selected backend creates coarse block spans and hashes.
4. The scanner computes numbering, labels, citations, and block summaries.
5. Dependency rules attach compact dependency fingerprints.
6. `SmartRenderer` emits block metadata and initial HTML according to virtual mode.
7. The preview runtime creates shells, mounts nearby blocks, and loads heavy resources only when requested.

## Incremental update

```text
source edit
    -> update spans and metadata
    -> compare block hashes
    -> collect changed and dependency-dirty blocks
    -> reuse or update block scan summaries
    -> render requested dirty blocks
    -> send patch or full payload
    -> update mounted DOM and virtual shells
```

Unchanged block text is not duplicated into long-lived renderer snapshots. Hashes determine source equality; dependency fingerprints catch blocks whose own source is unchanged but whose external metadata changed.

## Rendering rules

Legacy preprocessing rules run in ascending priority, protecting generated HTML before Markdown-it. AST render rules can consume structured nodes first in AST mode. Unclaimed content still passes through the established rendering helpers, preserving behavior shared with the legacy backend.

## Full versus patch update

Patches preserve unchanged DOM, PDF canvases, and TikZ SVGs. A full update is reserved for initial load, structural resets such as backend switching, and sufficiently broad changes under the renderer's established threshold.

## Heavy resources

The initial payload does not eagerly compile every TikZ picture or draw every PDF page. The webview requests or activates heavy work when the owning block mounts. Stale TikZ jobs are cancelled by generation-aware scheduling, while the previous successful SVG stays visible until replacement succeeds.
