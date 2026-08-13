# `context.renderLabel`

Creates the hidden preview anchor for a LaTeX label.

## Signature

```ts
context.renderLabel(label: string): string
```

## Returns

Direct HTML for a hidden anchor whose ID and `data-label` are safely escaped.

## Call relationships

- **Called by:** AST label and labeled-structure rules.
- **Provides targets for:** references, preview navigation, and tooltips.
- **Does not:** assign numbering by itself.

```ts
const anchor = context.renderLabel('sec:introduction');
```

## See also

- [`context.renderRef`](./context-render-ref)
