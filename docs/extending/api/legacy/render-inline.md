# `renderer.renderInline`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Runs the configured Markdown-it inline renderer on a text fragment. Use it for Markdown-compatible inline text after any LaTeX-specific transformation has already happened.

## Signature

```ts
renderer.renderInline(text: string): string
```

## Parameters

| Parameter | Description |
| --- | --- |
| `text` | Inline Markdown-compatible text |

## Returns

Rendered inline HTML. If the Markdown engine is unavailable, the implementation returns the input text.

## Call relationships

- **Called by:** legacy rules after their LaTeX-specific transformations.
- **Calls:** `MarkdownIt.renderInline`.
- **Often paired with:** [`protectHtml`](./protect-html) when the result is inserted into the outer legacy pipeline.

```ts
const html = renderer.renderInline('A *short* description');
return renderer.protectHtml('description', html, 'inline');
```

This function handles Markdown, not arbitrary LaTeX. Use [`renderInlineLatexHtml`](../rendering/render-inline-latex-html) when the fragment contains supported LaTeX styles or inline math.

## See also

- [`renderInlineLatexHtml`](../rendering/render-inline-latex-html)
- [Legacy rule contract](../contracts/legacy-rules)
