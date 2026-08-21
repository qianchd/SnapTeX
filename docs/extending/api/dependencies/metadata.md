# `deps.metadata`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Creates a dependency descriptor for one path in document metadata. Call it through `deps` inside a `BlockDependencyRule`; it is not a global metadata lookup.

## Signature

```ts
deps.metadata(path: string): RenderDependency
```

## Parameters

`path` uses dot-separated property names, such as `title`, `authors`, or `custom.editor`.

## Returns

A descriptor with ID `metadata:${path}`. When fingerprinted, string values are used directly, objects and arrays use `JSON.stringify`, and absent values become an empty string.

## Call relationships

- **Called inside:** [`BlockDependencyRule`](./collect).
- **Read by:** `SmartRenderer` against current `document.metadata`.
- **Can mark dirty:** a source-unchanged block when the current value differs.

```text
metadata path -> descriptor stored on block -> current metadata value -> fingerprint
```

```ts
return [
    deps.metadata('title'),
    deps.metadata('custom.editor')
];
```

The descriptor does not copy metadata into the block snapshot; it stores the path and reads current state during fingerprinting.

## See also

- [`deps.citedKeys`](./cited-keys)
- [Metadata and Dependencies Tutorial](../../metadata)
