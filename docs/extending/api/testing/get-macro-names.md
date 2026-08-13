# `PreviewUpdateService.getMacroNames`

Returns macro names known to the current document.

## Signature

```ts
service.getMacroNames(): string[]
```

## Returns

A new, locale-sorted array of keys from `document.metadata.macros`.

## Call relationships

- **Reads:** metadata state populated by the latest [`render`](./render).
- **Called by:** host LaTeX completion providers and tests.
- **Does not:** expose or mutate the macro definitions object.

## See also

- [`getBibliographyKeys`](./get-bibliography-keys)
- [`PreviewUpdateService.render`](./render)
