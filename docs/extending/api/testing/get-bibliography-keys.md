# `PreviewUpdateService.getBibliographyKeys`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Returns bibliography keys known to the current document.

## Signature

```ts
service.getBibliographyKeys(): string[]
```

## Returns

A new array containing keys from `document.bibEntries`. The order is not part of the API contract; sort the result at the presentation boundary when needed.

## Call relationships

- **Reads:** bibliography state populated by the latest [`render`](./render).
- **Called by:** host completion providers and tests.
- **Does not:** expose or mutate the internal map.

## See also

- [`getMacroNames`](./get-macro-names)
- [`PreviewUpdateService.render`](./render)
