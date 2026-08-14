# `context.renderRef`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Renders one or more reference targets as preview links. Call it from an AST rule after reading the labels from `\ref`, `\ref*`, `\eqref`, or `\eqref*`.

## Signature

```ts
context.renderRef(
    labels: readonly string[],
    type: 'ref' | 'eqref'
): string
```

## Returns

Direct reference-link HTML. `eqref` applies equation-style parentheses; numbering placeholders are resolved by the normal scanner/update pipeline.

## Call relationships

- **Called by:** AST `\\ref`, `\\ref*`, `\\eqref`, and `\\eqref*` rules.
- **Targets anchors created by:** [`context.renderLabel`](./context-render-label).

```ts
return { html: context.renderRef(['eq:loss'], 'eqref') };
```

## See also

- [`context.renderLabel`](./context-render-label)
