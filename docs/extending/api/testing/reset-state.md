# `PreviewUpdateService.resetState`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Clears retained document-render lifecycle state.

## Signature

```ts
service.resetState(): void
```

## Call relationships

- **Calls:** `SmartRenderer.resetState` and `LatexDocument.cancelAstArtifactWarmup`.
- **Clears:** stored diagnostics.
- **Called automatically when:** the backend mode changes during [`render`](./render).

Use it in a host or test only when the next update must behave like a fresh preview lifecycle.

## See also

- [`PreviewUpdateService.render`](./render)
