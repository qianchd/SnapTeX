# `PreviewUpdateService.renderBlockByIndex`

Renders one previously parsed block for lazy or virtualized preview mounting.

## Signature

```ts
service.renderBlockByIndex(
    index: number
): Promise<{ hash: string; html?: string } | undefined>
```

## Parameters

| Parameter | Description |
| --- | --- |
| `index` | Zero-based block index from the latest render payload |

## Returns

The block metadata and HTML when the index exists, otherwise `undefined`. The service automatically selects synchronous legacy rendering or asynchronous AST rendering according to its current backend.

## Call relationships

- **Requires:** a preceding [`render`](./render) call to populate document and renderer state.
- **Calls:** `SmartRenderer.renderBlockByIndex` or `renderBlockByIndexAsync`.
- **Used by:** viewport virtualization and lazy-render tests.

```ts
await service.render(uri, source, { deferFullHtml: true });
const block = await service.renderBlockByIndex(0);
assert.match(block?.html ?? '', /First paragraph/);
```

## See also

- [`PreviewUpdateService.render`](./render)
- [Long Documents](../../../features/long-documents)
