# `PreviewUpdateService.getSourceSyncData`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Maps a preview position back to source synchronization data.

## Signature

```ts
service.getSourceSyncData(
    blockIndex: number,
    ratio: number,
    options?: {
        anchors?: readonly string[];
        sourceStart?: number;
        sourceEnd?: number;
    }
)
```

## Parameters

`ratio` is the vertical position within the rendered block. `options.sourceStart` and `options.sourceEnd` provide an exact AST source span; when no span is available, `options.anchors` refines the ratio estimate with nearby text.

## Call relationships

- **Delegates to:** `SmartRenderer.getSourceSyncData`.
- **Reads:** current block map and stored sync hints.
- **Does not:** trigger parsing or rendering.

Call it after [`render`](./render), using a block index from the current payload.

## Returns

A `SourceLocation` containing `file` and `line`; returns `null` when no current mapping exists.

## See also

- [`getPreviewSyncData`](./get-preview-sync-data)
- [Sync Model](../../../development/sync-model)
