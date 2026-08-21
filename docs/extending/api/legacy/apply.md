# `PreprocessRule.apply`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Transforms one block in the legacy rendering pipeline. You implement this callback on a `PreprocessRule`; you do not call it directly.

## Signature

```ts
apply(text: string, renderer: RenderContext): string
```

## Parameters

| Parameter | Description |
| --- | --- |
| `text` | Current block after all lower-priority legacy rules |
| `renderer` | Current document's legacy `RenderContext` |

`SmartRenderer` supplies both values. The rule should treat `text` as its complete input and return a string for the next rule even when no match is found.

## Returns

The source passed to the next legacy rule. After the final rule, Markdown-it renders the result and protected HTML is restored.

## Call relationships

- **Called by:** `SmartRenderer.renderBlockToHtml` in ascending rule priority.
- **Usually calls:** balanced source readers, [`renderer.protectHtml`](./protect-html), or [`renderer.renderInline`](./render-inline).
- **Does not run in:** AST mode.

```text
previous rule output -> apply(text, renderer) -> next rule input -> Markdown
```

```ts
const RULE: PreprocessRule = {
    priority: 200,
    apply: (text, _renderer) =>
        text.replace(/\\draftmarker\b/g, '')
};
```

SnapTeX still supplies the second argument. The `_renderer` name makes the
complete callback shape visible while showing that this rule intentionally
does not use the rendering context.

`priority` controls ordering; it does not match source. Always return the unmodified `text` when the rule does not apply.

## See also

- [Legacy rule contract](../contracts/legacy-rules)
- [`replaceLatexCommandCalls`](../source/replace-latex-command-calls)
