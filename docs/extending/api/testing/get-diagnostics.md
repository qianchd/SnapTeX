# `PreviewUpdateService.getDiagnostics`

Reads diagnostics from the most recent document parse.

## Signature

```ts
service.getDiagnostics(): readonly DocumentDiagnostic[]
```

## Returns

A read-only view of the diagnostics stored by the latest [`render`](./render) call. `resetState` clears the list.

## Call relationships

- **State written by:** `LatexDocument.parse` inside `render`.
- **Called by:** hosts that surface parse warnings or tests that assert recovery behavior.

## See also

- [`PreviewUpdateService.render`](./render)
- [`resetState`](./reset-state)
