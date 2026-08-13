# Registry Contract

`RuleRegistry` is the single extension definition consumed by the document model and renderer.

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
| `splitterConfig` | Document splitter | Numeric limits |
| `splitterRules` | Document splitter | Declarative structural hints |

Build a registry with [`defineRuleRegistry`](../registry/define-rule-registry). The default instance is `SNAP_TEX_RULES` in `src/rules.ts`.

The two rendering arrays are independent. Add a rule only to the backend it targets.

## Related APIs

- [`defineRuleRegistry`](../registry/define-rule-registry)
- [Legacy rule contract](./legacy-rules)
- [AST rule contract](./ast-rules)
- [Metadata and dependency contract](./metadata-dependencies)
- [Splitter contract](./splitter)
