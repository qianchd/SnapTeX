# `context.resolveCitation`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Returns the stable first-seen citation number for one key in AST mode. It mutates citation state; use it while rendering a citation, not to test whether a key exists.

## Signature

```ts
context.resolveCitation(key: string): number
```

## Returns

A one-based citation number. First use records the key; repeated use returns the existing number.

## Call relationships

- **Delegates to:** the same renderer citation state as legacy [`resolveCitation`](../legacy/resolve-citation).
- **Updates:** [`context.getCitedKeys`](./context-get-cited-keys).
- **Usually called by:** citation helpers rather than ordinary rules.

```ts
const number = context.resolveCitation('smith2024');
```

## See also

- [`context.renderCitation`](./context-render-citation)
- [`context.getCitedKeys`](./context-get-cited-keys)
