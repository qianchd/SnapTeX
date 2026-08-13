# `context.renderMath`

Renders TeX math to direct KaTeX HTML in AST mode.

## Signature

```ts
context.renderMath(tex: string, displayMode: boolean): string
```

## Returns

KaTeX HTML using the current document macros. Unlike legacy [`renderMath`](../rendering/render-math), this result is not a protection token.

## Call relationships

- **Calls:** KaTeX with the current AST render context macros.
- **Called by:** AST math rules and inline rendering callbacks.

```ts
const mathHtml = context.renderMath('x^2', false);
return { html: mathHtml };
```

Do not wrap the result in legacy `protectHtml`; AST output bypasses Markdown.

## See also

- [`renderMath`](../rendering/render-math)
- [`renderInlineLatexHtml`](../rendering/render-inline-latex-html)
