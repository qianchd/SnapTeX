# `context.sourceSlice`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Returns the source represented by one AST node. Use it when a structural rule needs the original spelling or whitespace rather than rendered HTML.

## Signature

```ts
context.sourceSlice(node: SnaptexAstNode): string
```

## Returns

The exact substring from the current block when the node has source offsets. Otherwise SnapTeX reconstructs readable node text.

## Call relationships

- **Uses:** node source positions and the current block source.
- **Called by:** AST rules that need original command spelling or whitespace.
- **Does not:** render or escape the result.

```ts
const original = context.sourceSlice(input.node);
```

Treat the result as source text. Escape or render it before adding it to HTML.

## See also

- [`context.sourceContent`](./context-source-content)
- [`input.renderSource`](./render-source)
