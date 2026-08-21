# `PreviewUpdateService.render`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Parses source, applies incremental document state, and returns a full or patch preview payload. In rule tests, call it to verify final behavior through the same document and renderer lifecycle used by hosts.

## Signature

```ts
service.render(
    uri: TUri,
    text: string,
    options: PreviewRenderOptions
): Promise<RenderPayload>
```

```ts
interface PreviewRenderOptions {
    deferFullHtml: boolean;
    backendMode?: 'legacy' | 'ast(experimental)';
    resetPreviewState?: boolean;
    trace?: (label: string) => void;
    transformHtml?: (html: string) => string | Promise<string>;
}
```

## Call relationships

1. Calls `LatexDocument.parse` with the selected backend.
2. Applies the parse result to the document model.
3. Calls `SmartRenderer.render` or `renderAsync`.
4. Releases transient parse text after the renderer keeps its source snapshot.
5. Applies optional HTML transformation to payload HTML.

With deferred AST rendering, `renderBlockByIndex` creates compact source hints while producing that block's HTML. The preview's background height pass eventually requests unmounted blocks, so hint generation does not require a second full-document parse.

Changing `backendMode` resets document/renderer state and forces preview state reset.

## Example

```ts
const payload = await service.render(uri, source, {
    backendMode: 'legacy',
    deferFullHtml: false
});

const html = payload.htmls?.join('') ?? '';
assert.match(html, /Expected output/);
```

Set `deferFullHtml: true` to receive block metadata first and request viewport blocks through [`renderBlockByIndex`](./render-block-by-index).

The deferred full payload uses compact block metadata:

```ts
interface RenderedBlockMeta {
    index: number;
    hash: string;
    line: number;
    lineCount: number;
    anchors?: string[];
}
```

`anchors` lists jump targets that must remain available while HTML is virtualized. It is omitted when the block has no targets; consumers should use `block.anchors ?? []` rather than require an empty array.

## See also

- [`PreviewUpdateService`](./preview-update-service)
- [`renderBlockByIndex`](./render-block-by-index)
