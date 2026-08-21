# `context.renderMath`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Renders TeX math to direct KaTeX HTML in AST mode. The AST renderer supplies `context` when it calls your rule.

## Signature

```ts
context.renderMath(tex: string, displayMode: boolean): string
```

## Returns

KaTeX HTML using the current document macros. Unlike legacy [`renderMath`](../rendering/render-math), this result is not a protection token.

## Call relationships

- **Calls:** KaTeX with the current AST render context macros.
- **Called by:** AST math rules and inline rendering callbacks.

```text
TeX body + current macros -> context.renderMath -> final KaTeX HTML
```

```ts
const mathHtml = context.renderMath('x^2', false);
return { html: mathHtml };
```

Do not wrap the result in legacy `protectHtml`; AST output bypasses Markdown.

## See also

- [`renderMath`](../rendering/render-math)
- [`renderInlineLatexHtml`](../rendering/render-inline-latex-html)
