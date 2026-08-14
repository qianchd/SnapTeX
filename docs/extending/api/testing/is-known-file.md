# `PreviewUpdateService.isKnownFile`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Checks whether a URI belongs to the current parsed project.

## Signature

```ts
service.isKnownFile(uri: string): boolean
```

## Returns

`true` when the normalized URI matches the current root directory or an entry in the document file pool.

## Call relationships

- **Delegates to:** `SmartRenderer.isKnownFile`.
- **Reads:** state established by the latest [`render`](./render).
- **Called by:** hosts filtering editor/file events for the active preview project.

## See also

- [`PreviewUpdateService`](./preview-update-service)
