# `context.getCitedKeys`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Reads citation keys currently registered during AST rendering. Use it for bibliography output after citation rules have populated the shared state.

## Signature

```ts
context.getCitedKeys(): readonly string[]
```

## Returns

A new read-only array snapshot in first-seen order, read from the same renderer citation state used by legacy rules.

## Call relationships

- **Reads state written by:** [`context.resolveCitation`](./context-resolve-citation) and [`context.renderCitation`](./context-render-citation).
- **Called by:** AST bibliography rules.
- **Does not:** sort or mutate renderer citation state.

```ts
const keys = context.getCitedKeys();
```

Call the method again after registering more citations; an earlier snapshot does not update in place.

## See also

- [`context.renderCitation`](./context-render-citation)
- [`deps.citedKeys`](../dependencies/cited-keys)
