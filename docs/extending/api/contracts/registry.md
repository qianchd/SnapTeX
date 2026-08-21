# Registry Contract

<!--@include: ../../../.vitepress/partials/api-context.md-->

`RuleRegistry` is the single assembly object consumed by the document model and renderer. Individual rule constants are inert until they appear in the corresponding registry field.

```ts
interface RuleRegistry {
    readonly metadataExtractors: readonly MetadataExtractor[];
    readonly renderRules: readonly PreprocessRule[];
    readonly astRenderRules: readonly AstRenderRule[];
    readonly blockDependencyRules: readonly BlockDependencyRule[];
    readonly splitterConfig: SplitterConfig;
    readonly splitterRules: readonly SplitterRule[];
}
```

## Field ownership

| Field | Consumer | Ordering |
| --- | --- | --- |
| `metadataExtractors` | `LatexDocument` | Array order |
| `renderRules` | Legacy `SmartRenderer` | Ascending `priority` |
| `astRenderRules` | AST renderer | Array order; first returned result wins |
| `blockDependencyRules` | `SmartRenderer` | All collectors contribute descriptors |
| `splitterConfig` | Legacy coarse splitter and AST refinement | Numeric limits |
| `splitterRules` | Legacy coarse splitter and AST refinement | Declarative structural hints selected by `kind` |

Build a registry with [`defineRuleRegistry`](../registry/define-rule-registry). The default instance is `SNAP_TEX_RULES` in `src/rules.ts`.

The two rendering arrays are independent. Add a rule only to the backend it targets.

## From field to callback

| Registry field | SnapTeX later calls | Callback return becomes |
| --- | --- | --- |
| `metadataExtractors` | `extract(source)` | Merged document metadata and hidden source ranges |
| `renderRules` | `apply(text, renderer)` | Input text for the next legacy rule |
| `astRenderRules` | `(input, context) => result` | Final HTML for one claimed AST node |
| `blockDependencyRules` | `(input) => dependencies` | Stored descriptors used to dirty unchanged blocks |
| `splitterRules` | No user callback; the splitter reads declarations | Source block spans |

`splitterConfig` and `splitterRules` influence parsing before either render-rule array runs. They are not fallback renderers.

## Related APIs

- [`defineRuleRegistry`](../registry/define-rule-registry)
- [Legacy rule contract](./legacy-rules)
- [AST rule contract](./ast-rules)
- [Metadata and dependency contract](./metadata-dependencies)
- [Splitter contract](./splitter)
