# `context.sourceContent`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Returns the source span covered by a list of AST nodes. Use it to recover one contiguous source fragment; use `renderChildren` when the goal is HTML.

## Signature

```ts
context.sourceContent(nodes: readonly SnaptexAstNode[]): string
```

## Returns

The exact current-block substring from the earliest node start to the latest node end when ranges exist; otherwise reconstructed node text.

## Call relationships

- **Uses:** the combined AST node range and current block source.
- **Called by:** rules that need one contiguous source fragment for several nodes.
- **Does not:** render or escape the result.

```ts
const source = context.sourceContent(input.node.content ?? []);
```

Use [`renderChildren`](./render-children) when the goal is HTML rather than source recovery.

## See also

- [`context.sourceSlice`](./context-source-slice)
- [`renderChildren`](./render-children)
