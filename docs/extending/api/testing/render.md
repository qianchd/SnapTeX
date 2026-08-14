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
4. Starts AST artifact warm-up when AST mode is selected.
5. Releases transient parse text.
6. Applies optional HTML transformation to payload HTML.

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

## See also

- [`PreviewUpdateService`](./preview-update-service)
- [`renderBlockByIndex`](./render-block-by-index)
