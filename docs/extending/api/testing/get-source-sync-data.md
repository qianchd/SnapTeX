# `PreviewUpdateService.getSourceSyncData`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Maps a preview position back to source synchronization data.

## Signature

```ts
service.getSourceSyncData(
    blockIndex: number,
    ratio: number,
    anchors?: readonly string[],
    sourceStart?: number,
    sourceEnd?: number
)
```

## Parameters

`ratio` is the vertical position within the rendered block. Optional text anchors and source offsets refine the match, especially for AST-rendered inline content.

## Call relationships

- **Delegates to:** `SmartRenderer.getSourceSyncData`.
- **Reads:** current block map and stored sync hints.
- **Does not:** trigger parsing or rendering.

Call it after [`render`](./render), using a block index from the current payload.

## Returns

A `SourceLocation` containing `file`, `line`, and, when available, the source `blockRange`; returns `null` when no current mapping exists.

## See also

- [`getPreviewSyncData`](./get-preview-sync-data)
- [Sync Model](../../../development/sync-model)
