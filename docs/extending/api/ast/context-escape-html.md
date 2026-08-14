# `context.escapeHtml`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Escapes plain text for direct insertion into AST-rendered HTML. Call it through the `context` received by `AstRenderRule.render`; do not import or construct that context.

## Signature

```ts
context.escapeHtml(text: string): string
```

## Returns

HTML-safe text. This context method uses the same implementation as [`escapeHtml`](../rendering/escape-html).

## Call relationships

- **Called by:** AST rules that promise plain-text arguments.
- **Returns:** direct HTML text, not a protected token.
- **Does not:** render nested LaTeX.

```text
plain source text -> context.escapeHtml -> safe HTML text -> rule HTML
```

```ts
return { html: `<span>${context.escapeHtml(content)}</span>` };
```

## See also

- [`escapeHtml`](../rendering/escape-html)
- [`renderChildren`](./render-children)
