# `context.getCitedKeys`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Reads citation keys currently registered during AST rendering. Use it for bibliography output after citation rules have populated the shared state.

## Signature

```ts
context.getCitedKeys(): readonly string[]
```

## Returns

A read-only first-seen-order view shared with the renderer's legacy citation state.

## Call relationships

- **Reads state written by:** [`context.resolveCitation`](./context-resolve-citation) and [`context.renderCitation`](./context-render-citation).
- **Called by:** AST bibliography rules.
- **Does not:** sort or clone the list.

```ts
const keys = context.getCitedKeys();
```

## See also

- [`context.renderCitation`](./context-render-citation)
- [`deps.citedKeys`](../dependencies/cited-keys)
