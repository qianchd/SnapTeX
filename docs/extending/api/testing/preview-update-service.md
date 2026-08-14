# `PreviewUpdateService`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Coordinates document parsing and renderer state without depending on a VS Code or Web UI. Use it for end-to-end rule tests and host integration; use lower-level helpers only for isolated parser or formatter tests.

## Constructor

```ts
new PreviewUpdateService<TUri>(
    fileProvider: IFileProvider<TUri>,
    registry: RuleRegistry = SNAP_TEX_RULES
)
```

## Parameters

| Parameter | Description |
| --- | --- |
| `fileProvider` | Host-neutral project file reader used for inputs, bibliography, images, and included files |
| `registry` | Registry under test; defaults to the built-in `SNAP_TEX_RULES` |

## Instance responsibilities

The service owns one `LatexDocument` and one `SmartRenderer`. It retains diff, numbering, citation, dependency, and lazy-render state across calls to [`render`](./render).

Useful methods include:

- [`render`](./render)
- [`renderBlockByIndex`](./render-block-by-index)
- [`resetState`](./reset-state)
- [`getDiagnostics`](./get-diagnostics)
- [`getPreviewSyncData`](./get-preview-sync-data) / [`getSourceSyncData`](./get-source-sync-data)
- [`isKnownFile`](./is-known-file)
- [`getBibliographyKeys`](./get-bibliography-keys) / [`getMacroNames`](./get-macro-names)

## Call relationships

- **Constructs:** `LatexDocument` and `SmartRenderer` with the same registry.
- **Used by:** VS Code, Web/standalone hosts, and end-to-end tests.

```text
file provider + registry -> PreviewUpdateService
                         -> LatexDocument + SmartRenderer
                         -> RenderPayload / lazy block HTML / sync data
```

```ts
const service = new PreviewUpdateService(
    new MemoryFileProvider(),
    SNAP_TEX_RULES
);
```

## See also

- [Call Relationships](../call-relationships)
- [`defineRuleRegistry`](../registry/define-rule-registry)
