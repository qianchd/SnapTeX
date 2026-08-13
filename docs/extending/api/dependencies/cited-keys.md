# `deps.citedKeys`

Creates a dependency descriptor for the document's stable cited-key set.

## Signature

```ts
deps.citedKeys(): RenderDependency
```

## Returns

A descriptor with ID `citations:list`. Its current value is a renderer-provided fingerprint of deduplicated, sorted citation keys.

## Call relationships

- **Called inside:** bibliography dependency collectors.
- **Read by:** `SmartRenderer` during dependency fingerprinting.
- **Can mark dirty:** an unchanged bibliography block after citations elsewhere are added or removed.

```ts
collect: ({ text, deps }) => text.includes('\\bibliography')
    ? [deps.citedKeys()]
    : []
```

The descriptor does not store a copy of every key. Sorting is appropriate for dependency comparison because SnapTeX's rendered bibliography is author-ordered, while [`getCitedKeys`](../legacy/get-cited-keys) still exposes first-seen render order.

## See also

- [`deps.metadata`](./metadata)
- [`renderer.getCitedKeys`](../legacy/get-cited-keys)
