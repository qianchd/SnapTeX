# API Call Relationships

This page shows when each extension API runs and which lower-level functions it normally calls. The arrows describe runtime calls, not import direction.

## Registry to rendering

```mermaid
flowchart LR
    R["SNAP_TEX_RULES"] --> D["defineRuleRegistry"]
    D --> L["LatexDocument"]
    D --> S["SmartRenderer"]
    L --> M["metadataExtractors"]
    L --> B["splitterConfig + splitterRules"]
    S --> P["renderRules (legacy)"]
    S --> A["astRenderRules (AST)"]
    S --> X["blockDependencyRules"]
```

`defineRuleRegistry` copies the registry collections and sorts only legacy rules by `priority`. `LatexDocument` consumes metadata and splitter definitions; `SmartRenderer` consumes rendering and dependency rules.

## Legacy rule flow

```mermaid
flowchart LR
    S["SmartRenderer"] --> A["PreprocessRule.apply"]
    A --> C["replaceLatexCommandCalls"]
    C --> CA["readLatexCommandAt"]
    CA --> G["readLatexGroup"]
    A --> I["renderer.renderInline"]
    I --> IH["renderInlineLatexHtml"]
    IH --> RM["renderMath callback"]
    A --> PH["renderer.protectHtml"]
    PH --> MD["Markdown-it"]
    MD --> RESTORE["restore protected HTML"]
```

Legacy rules receive source text in priority order. Generated HTML must be protected before Markdown conversion. Balanced readers are optional helpers, but they are the preferred way to read command arguments.

## AST rule flow

```mermaid
flowchart LR
    W["AST walker"] --> MATCH["AstRenderRule.match"]
    MATCH --> RENDER["AstRenderRule.render"]
    RENDER --> ARGS["readAstCommandArguments"]
    RENDER --> CHILD["input.renderChildren"]
    RENDER --> SOURCE["input.renderSource"]
    CHILD --> W
    SOURCE --> PARSE["parse generated source"]
    PARSE --> W
    RENDER --> CTX["AstRenderContext methods"]
```

The first AST rule that matches and returns a result claims the node. `renderChildren` reuses existing child nodes. `renderSource` parses generated source and is intended for macro expansion or reconstructed LaTeX, not ordinary child traversal.

## Metadata and dependencies

```mermaid
flowchart LR
    DOC["LatexDocument.parse"] --> EXTRACT["MetadataExtractor.extract"]
    EXTRACT --> META["document.metadata"]
    BLOCK["block source"] --> COLLECT["BlockDependencyRule.collect"]
    COLLECT --> DESC["dependency descriptors"]
    META --> FP["current fingerprints"]
    DESC --> FP
    FP --> DIRTY["dirty block"]
    DIRTY --> RENDER["SmartRenderer"]
```

Dependency collection identifies *what* a block depends on. SnapTeX stores the descriptors for unchanged blocks and recomputes their fingerprints from current document state, avoiding repeated source scans.

## End-to-end testing

```mermaid
flowchart LR
    TEST["PreviewUpdateService.render"] --> DOC["LatexDocument.parse"]
    DOC --> APPLY["LatexDocument.applyResult"]
    APPLY --> RENDER["SmartRenderer.render / renderAsync"]
    RENDER --> PAYLOAD["RenderPayload"]
    TEST --> BLOCK["renderBlockByIndex"]
```

Use `PreviewUpdateService` when a test needs to verify the behavior a host actually receives, including parsing, block diffing, numbering, dependencies, and backend selection.

## Related contracts

- [Registry contract](./contracts/registry)
- [Legacy rule contract](./contracts/legacy-rules)
- [AST rule contract](./contracts/ast-rules)
- [Metadata and dependency contract](./contracts/metadata-dependencies)
- [Splitter contract](./contracts/splitter)
