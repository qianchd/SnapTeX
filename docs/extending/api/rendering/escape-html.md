# `escapeHtml`

Escapes plain text for insertion into HTML content.

## Signature

```ts
function escapeHtml(text: string): string
```

## Parameters

| Parameter | Description |
| --- | --- |
| `text` | Untrusted or plain source text |

## Returns

A string with `&`, `<`, `>`, `"`, and `'` represented as HTML entities.

## Call relationships

- **Called by:** legacy and AST rendering rules before interpolating plain text into HTML.
- **Often followed by:** [`renderer.protectHtml`](../legacy/protect-html) in legacy mode.
- **Equivalent AST context method:** [`context.escapeHtml`](../ast/context-escape-html).

```ts
const html = `<span>${escapeHtml(userText)}</span>`;
```

This function escapes element content. Use the repository's attribute-specific helpers for URLs or HTML attributes rather than assuming content escaping validates them.

## See also

- [`renderInlineLatexHtml`](./render-inline-latex-html)
- [`renderer.protectHtml`](../legacy/protect-html)
