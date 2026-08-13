# `renderer.getCitedKeys`

Reads citation keys currently registered by the renderer.

## Signature

```ts
renderer.getCitedKeys(): readonly string[]
```

## Returns

A read-only view in first-seen order. Duplicate citation calls do not add duplicate keys.

## Call relationships

- **Reads state written by:** [`resolveCitation`](./resolve-citation).
- **Called by:** bibliography and citation-aware rendering rules.
- **Does not:** clone, sort, or mutate the list.

```ts
const cited = renderer.getCitedKeys();
if (cited.length === 0) {
    return 'No citations found.';
}
```

Dependency fingerprints use a separate stable deduplicated/sorted representation through [`deps.citedKeys`](../dependencies/cited-keys); this method preserves render order.

## See also

- [`resolveCitation`](./resolve-citation)
- [`deps.citedKeys`](../dependencies/cited-keys)
