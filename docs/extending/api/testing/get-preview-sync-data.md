# `PreviewUpdateService.getPreviewSyncData`

Maps a source cursor position to preview synchronization data.

## Signature

```ts
service.getPreviewSyncData(
    filePath: string,
    line: number,
    character?: number
)
```

## Parameters

`line` and optional `character` identify the editor position in `filePath`.

## Call relationships

- **Delegates to:** `SmartRenderer.getPreviewSyncData`.
- **Reads:** source map, block map, and stored AST sync hints when available.
- **Does not:** parse AST or render blocks during the sync request.

Call it only after [`render`](./render) has established current document state.

## Returns

`{ index, ratio, sourceStart?, sourceEnd? }` for a known source position, or `null` when no current document/source mapping exists. `index` identifies the preview block and `ratio` is its estimated vertical position; AST source hints may add exact block-relative offsets.

## See also

- [`getSourceSyncData`](./get-source-sync-data)
- [Sync Model](../../../development/sync-model)
