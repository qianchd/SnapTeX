# `PreprocessRule.apply`

Transforms one block in the legacy rendering pipeline.

## Signature

```ts
apply(text: string, renderer: RenderContext): string
```

## Parameters

| Parameter | Description |
| --- | --- |
| `text` | Current block after all lower-priority legacy rules |
| `renderer` | Current document's legacy `RenderContext` |

## Returns

The source passed to the next legacy rule. After the final rule, Markdown-it renders the result and protected HTML is restored.

## Call relationships

- **Called by:** `SmartRenderer.renderBlockToHtml` in ascending rule priority.
- **Usually calls:** balanced source readers, [`renderer.protectHtml`](./protect-html), or [`renderer.renderInline`](./render-inline).
- **Does not run in:** AST mode.

```ts
const RULE: PreprocessRule = {
    name: 'remove-draft-marker',
    priority: 200,
    apply: text => text.replace(/\\draftmarker\b/g, '')
};
```

`name` is diagnostic; it does not match source. Always return the unmodified `text` when the rule does not apply.

## See also

- [Legacy rule contract](../contracts/legacy-rules)
- [`replaceLatexCommandCalls`](../source/replace-latex-command-calls)
