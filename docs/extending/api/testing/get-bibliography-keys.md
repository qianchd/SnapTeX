# `PreviewUpdateService.getBibliographyKeys`

Returns bibliography keys known to the current document.

## Signature

```ts
service.getBibliographyKeys(): string[]
```

## Returns

A new array containing keys from `document.bibEntries`, sorted with `localeCompare`.

## Call relationships

- **Reads:** bibliography state populated by the latest [`render`](./render).
- **Called by:** host completion providers and tests.
- **Does not:** expose or mutate the internal map.

## See also

- [`getMacroNames`](./get-macro-names)
- [`PreviewUpdateService.render`](./render)
