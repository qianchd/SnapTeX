# `defineBlockDependencyRule`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Preserves a block dependency rule unchanged while providing contextual TypeScript typing. Use it only when unchanged block source can render differently because document-level state changed.

## Signature

```ts
function defineBlockDependencyRule(rule: BlockDependencyRule): BlockDependencyRule
```

## Parameters

| Parameter | Description |
| --- | --- |
| `rule` | Dependency callback |

## Returns

The same callback. Registration happens only when it is added to `blockDependencyRules`.

## Call relationships

- **Called by:** dependency declarations in `src/rules.ts`.
- **Collector executed by:** `SmartRenderer` for new or source-changed blocks.
- **Collector usually calls:** [`deps.metadata`](../dependencies/metadata) or [`deps.citedKeys`](../dependencies/cited-keys).

```text
callback -> defineBlockDependencyRule -> blockDependencyRules registration
                                       -> SmartRenderer dependency collection
```

## Example

```ts
const RULE = defineBlockDependencyRule(({ text, deps }) => text.includes('\\makecover')
        ? [deps.metadata('title')]
        : []
);
```

Do not add a dependency when output depends only on the block's own source; source hashing already handles that case.

## See also

- [Metadata and dependency contract](../contracts/metadata-dependencies)
- [`BlockDependencyRule`](../dependencies/collect)
