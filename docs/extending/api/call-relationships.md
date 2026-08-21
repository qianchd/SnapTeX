# API Call Relationships

<!--@include: ../../.vitepress/partials/api-context.md-->

This page shows when each extension API runs and which lower-level functions it normally calls. The arrows describe runtime calls, not import direction.

## Runtime values at a glance

These names appear repeatedly in rule examples, but they are created at different layers:

| Value | Created by | Available inside | Primary role |
| --- | --- | --- | --- |
| `text` | Legacy block renderer | `PreprocessRule.apply` | Current transformed block source |
| `renderer` | `SmartRenderer` | `PreprocessRule.apply` | Legacy document state and protected-output services |
| `input` | AST walker | `AstRenderRule` | Current node, siblings, and recursive rendering |
| `context` | AST renderer | `AstRenderRule` | AST document state and direct-HTML services |
| `call` | `replaceLatexCommandCalls` | Its nested `render` callback | One balanced source command call |
| `deps` | Dependency collector host | `BlockDependencyRule` | Factories for stable dependency descriptors |

Your rule never constructs these objects. It declares callbacks; the owning service creates the values and invokes the callbacks.

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

A declaration helper and the registry have different jobs:

```text
defineAstRenderRule(rule)       -> type-check and return one declaration
defineBlockDependencyRule(rule) -> type-check and return one declaration
defineRuleRegistry({...})        -> assemble the declarations used by a preview lifecycle
```

## Splitter flow

```mermaid
flowchart LR
    SOURCE["cleaned document body"] --> MODE{"backend mode"}
    MODE -->|legacy| COARSE["LatexBlockSplitter"]
    COARSE --> LEGACY["final block spans"]
    MODE -->|AST| ASTCOARSE["LatexBlockSplitter"]
    ASTCOARSE --> ADJUST["trim or merge transparent wrappers"]
    ADJUST --> SELECT{"needs AST refinement?"}
    SELECT -->|no| REUSE["reuse coarse span"]
    SELECT -->|yes| REFINE["parse and refine coarse span"]
    REUSE --> ASTFINAL["final block spans"]
    REFINE --> ASTFINAL
```

AST mode shares the mature coarse splitter rather than replacing it. On later
edits, coarse hashes let the document reuse unchanged refined spans and run AST
refinement only for the changed coarse range. See the
[Splitter Contract](./contracts/splitter) for the rule-kind ownership matrix.

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

The nested `render(call)` callback belongs to `replaceLatexCommandCalls`; it is invoked only for a syntactically valid command. Its returned string replaces that command inside the block passed to the next legacy rule.

## AST rule flow

```mermaid
flowchart LR
    W["AST walker"] --> RENDER["AstRenderRule"]
    RENDER --> ARGS["readAstCommandArguments"]
    RENDER --> CHILD["input.renderChildren"]
    RENDER --> SOURCE["input.renderSource"]
    CHILD --> W
    SOURCE --> PARSE["parse generated source"]
    PARSE --> W
    RENDER --> CTX["AstRenderContext methods"]
```

The first AST rule that returns a result claims the node; `undefined` passes it to the next rule. `renderChildren` reuses existing child nodes. `renderSource` parses generated source and is intended for macro expansion or reconstructed LaTeX, not ordinary child traversal.

`AstRenderRule` returns final HTML. `consumedNodes` controls how far the walker advances; it is not an HTML property and does not represent child count.

## Metadata and dependencies

```mermaid
flowchart LR
    DOC["LatexDocument.parse"] --> EXTRACT["MetadataExtractor"]
    EXTRACT --> META["document.metadata"]
    BLOCK["block source"] --> COLLECT["BlockDependencyRule"]
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
