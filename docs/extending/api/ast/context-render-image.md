# `context.renderImage`

Renders an image reference through the current host-aware image renderer.

## Signature

```ts
context.renderImage(path: string, options?: string): string
```

## Parameters

| Parameter | Description |
| --- | --- |
| `path` | LaTeX image path |
| `options` | Optional raw `\\includegraphics` option text |

## Returns

Direct image HTML. In the production renderer the host later resolves project resources through its normal resource pipeline.

The interface preserves `options` for host contexts and isolated tests. SnapTeX's current production `SmartRenderer` delegates only `path`, so a custom rule must not rely on production handling of width/scale options yet.

## Call relationships

- **Called by:** AST figure and `\\includegraphics` rules.
- **Configured by:** `SmartRenderer.createAstRenderContext`.
- **Default context:** emits an escaped `<img>` element for isolated rule tests.

```ts
return { html: context.renderImage('figures/result.pdf', 'width=\\linewidth') };
```

Do not construct host resource URIs inside a rule; keep path resolution in the renderer/host layer.

## See also

- [AST rule contract](../contracts/ast-rules)
