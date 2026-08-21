# `renderer.getCitedKeys`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Reads citation keys currently registered by the renderer. Use it for bibliography output after citation rules have populated the shared state.

## Signature

```ts
renderer.getCitedKeys(): readonly string[]
```

## Returns

A new read-only array snapshot in first-seen order. Duplicate citation calls do not add duplicate keys.

## Call relationships

- **Reads state written by:** [`resolveCitation`](./resolve-citation).
- **Called by:** bibliography and citation-aware rendering rules.
- **Does not:** sort or mutate renderer citation state.

```ts
const cited = renderer.getCitedKeys();
if (cited.length === 0) {
    return 'No citations found.';
}
```

Dependency fingerprints use a separate stable deduplicated/sorted representation through [`deps.citedKeys`](../dependencies/cited-keys); this method preserves render order.

Call the method again when current state is required. A previously returned array does not update after later citations are registered.

## See also

- [`resolveCitation`](./resolve-citation)
- [`deps.citedKeys`](../dependencies/cited-keys)
