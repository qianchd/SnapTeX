# `PreviewUpdateService.getMacroNames`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Returns macro names known to the current document.

## Signature

```ts
service.getMacroNames(): string[]
```

## Returns

A new array of keys from `document.metadata.macros`. The order is not part of the API contract; sort the result at the presentation boundary when needed.

## Call relationships

- **Reads:** metadata state populated by the latest [`render`](./render).
- **Called by:** host LaTeX completion providers and tests.
- **Does not:** expose or mutate the macro definitions object.

## See also

- [`getBibliographyKeys`](./get-bibliography-keys)
- [`PreviewUpdateService.render`](./render)
