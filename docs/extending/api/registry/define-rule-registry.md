# `defineRuleRegistry`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Creates the registry consumed by document parsing and rendering. Call it when assembling the exported `SNAP_TEX_RULES`; it is not called from an individual render callback.

## Signature

```ts
function defineRuleRegistry(registry: RuleRegistry): RuleRegistry
```

## Parameters

| Parameter | Description |
| --- | --- |
| `registry` | Complete metadata, rendering, dependency, and splitter configuration |

## Returns

A new registry object. Every array and `splitterConfig` is shallow-copied. `renderRules` is sorted by ascending `priority`; other arrays preserve caller order.

## Call relationships

- **Called while:** constructing `SNAP_TEX_RULES` in `src/rules.ts`.
- **Consumed by:** `LatexDocument`, `SmartRenderer`, and `PreviewUpdateService`.
- **Does not call:** rule callbacks or render source.

```text
rule constants -> defineRuleRegistry -> SNAP_TEX_RULES
                                      -> LatexDocument + SmartRenderer
```

## Example

```ts
export const SNAP_TEX_RULES = defineRuleRegistry({
    metadataExtractors: [BUILTIN_METADATA_EXTRACTOR],
    renderRules: DEFAULT_RENDER_RULES,
    astRenderRules: DEFAULT_AST_RENDER_RULES,
    blockDependencyRules: DEFAULT_BLOCK_DEPENDENCY_RULES,
    splitterConfig: DEFAULT_SPLITTER_CONFIG,
    splitterRules: DEFAULT_SPLITTER_RULES
});
```

The returned registry is a lifecycle snapshot. Rebuild and reload SnapTeX after changing rule definitions.

## See also

- [Registry contract](../contracts/registry)
- [`defineAstRenderRule`](./define-ast-render-rule)
- [`defineBlockDependencyRule`](./define-block-dependency-rule)
