# `renderInlineLatexHtml`

Converts a small, explicit subset of inline LaTeX to safe HTML.

## Signature

```ts
function renderInlineLatexHtml(
    text: string | undefined,
    renderMathHtml: (tex: string) => string
): string
```

## Parameters

| Parameter | Description |
| --- | --- |
| `text` | Inline LaTeX fragment; `undefined` returns an empty string |
| `renderMathHtml` | Callback that receives the body of each `$...$` expression and returns HTML |

The callback parameter `tex` is created by this function when it finds inline math. It is the trimmed content between the dollar delimiters.

## Returns

HTML with plain text escaped. The function handles supported text styles, simple text transforms, `\\`, `\\and`, non-breaking `~`, inline `$...$`, and removal of `\\footnote{...}`.

## Call relationships

- **Calls:** balanced command replacement, text-style resolution, and [`escapeHtml`](./escape-html).
- **Calls the supplied callback:** once per inline math expression.
- **Called by:** specialized legacy and AST inline renderers.

## Legacy example

```ts
const html = renderInlineLatexHtml(
    call.requiredArgs[0].content,
    tex => renderMath(tex, false, renderer)
);
```

Here `renderMath` returns a protected legacy token, which the inline renderer preserves while escaping surrounding text.

## AST example

```ts
const html = renderInlineLatexHtml(
    source,
    tex => context.renderMath(tex, false)
);
```

This is intentionally not a full LaTeX parser. For already parsed AST children, prefer [`input.renderChildren`](../ast/render-children).

## See also

- [`renderMath`](./render-math)
- [`escapeHtml`](./escape-html)
