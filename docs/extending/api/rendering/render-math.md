# `renderMath`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Renders TeX through KaTeX and protects the generated HTML for the legacy Markdown pipeline. Use this imported helper inside a legacy rule; AST rules call `context.renderMath` instead.

## Signature

```ts
function renderMath(
    tex: string,
    displayMode: boolean,
    renderer: RenderContext
): string
```

## Parameters

| Parameter | Description |
| --- | --- |
| `tex` | Math body without surrounding `$` delimiters |
| `displayMode` | `true` for display math, `false` for inline math |
| `renderer` | Current legacy rendering context |

## Returns

A protected token containing KaTeX HTML, suitable for insertion into transformed legacy source.

## Call relationships

- **Calls:** KaTeX with `renderer.currentMacros` and then [`renderer.protectHtml`](../legacy/protect-html).
- **Called by:** built-in math rules and custom legacy renderers.
- **AST equivalent:** [`context.renderMath`](../ast/context-render-math), which returns HTML directly.

```text
TeX body + legacy renderer -> KaTeX -> protectHtml -> temporary legacy token
```

```ts
const token = renderMath('x^2 + y^2', false, renderer);
```

KaTeX runs with `trust: false` and non-throwing error output. Do not include `$...$` around `tex`.

## See also

- [`renderInlineLatexHtml`](./render-inline-latex-html)
