# `renderInlineLatexHtml`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Converts a small, explicit subset of inline LaTeX to safe HTML. Use it when a string contains supported inline LaTeX but is not available as parsed AST children.

This is an imported helper defined in `src/rule-helpers.ts`. A rule normally imports it into `src/rules.ts`; SnapTeX does not inject it into the rule callback. See [Source API Scope](../scope) for the repository API model.

## Signature

```ts
function renderInlineLatexHtml(
    text: string | undefined,
    renderMathHtml: (tex: string) => string,
    colors?: Readonly<Record<string, string>>
): string
```

## Parameters

| Parameter | Description |
| --- | --- |
| `text` | Inline LaTeX fragment; `undefined` returns an empty string |
| `renderMathHtml` | Callback that receives the body of each `$...$` expression and returns HTML |
| `colors` | Optional preamble color map, normally `renderer.metadata?.colors` or `context.metadata?.colors` |

The caller supplies the callback function, but this helper supplies the callback's `tex` parameter. The helper needs that callback because legacy and AST modes obtain math HTML from different owners.

The callback parameter `tex` is created by this function when it finds inline math. It is the trimmed content between the dollar delimiters.

In other words, the caller supplies the callback function, then `renderInlineLatexHtml` invokes it with each discovered formula body:

```text
rule code supplies callback
        -> renderInlineLatexHtml scans text
        -> finds $x^2$
        -> calls callback('x^2')
        -> inserts returned math HTML
```

## Returns

HTML with plain text escaped. The function handles supported text styles, simple text transforms, `\\`, `\\and`, non-breaking `~`, inline `$...$`, and removal of `\\footnote{...}`.

## Call relationships

- **Calls:** balanced command replacement, text-style resolution, and [`escapeHtml`](./escape-html).
- **Calls the supplied callback:** once per inline math expression.
- **Called by:** specialized legacy and AST inline renderers.

```text
inline source -> renderInlineLatexHtml
              -> callback(tex) for each formula
              -> safe inline HTML
```

## Legacy example

```ts
const html = renderInlineLatexHtml(
    call.requiredArgs[0].content,
    tex => renderMath(tex, false, renderer),
    renderer.metadata?.colors
);
```

Here `renderMath` returns a protected legacy token, which the inline renderer preserves while escaping surrounding text.

The three values in this example come from different owners:

| Value | Supplied by |
| --- | --- |
| `call.requiredArgs[0].content` | `replaceLatexCommandCalls`, after reading the command argument |
| `tex` | `renderInlineLatexHtml`, once for each inline formula it finds |
| `renderer` | `SmartRenderer`, when it calls the enclosing legacy rule's `apply` method |
| `renderer.metadata?.colors` | Preamble scanner, after resolving supported `\definecolor` declarations |

## AST example

```ts
const html = renderInlineLatexHtml(
    source,
    tex => context.renderMath(tex, false),
    context.metadata?.colors
);
```

This is intentionally not a full LaTeX parser. For already parsed AST children, prefer [`input.renderChildren`](../ast/render-children).

Do not pass its returned HTML through `escapeHtml` again. In a legacy rule, protect the completed HTML before returning it to the outer Markdown pipeline.

## See also

- [`renderMath`](./render-math)
- [`escapeHtml`](./escape-html)
