# Legacy Rule Contract

A `PreprocessRule` transforms one block of LaTeX source before Markdown rendering.

```ts
interface PreprocessRule {
    name: string;
    priority: number;
    apply(text: string, renderer: RenderContext): string;
}
```

## Lifecycle

1. `defineRuleRegistry` sorts legacy rules by ascending `priority`.
2. `SmartRenderer` passes the current block through every [`apply`](../legacy/apply) callback.
3. Markdown-it renders the transformed text with raw HTML disabled.
4. SnapTeX restores HTML registered with `renderer.protectHtml`.

```ts
const RULE: PreprocessRule = {
    name: 'badge',
    priority: 200,
    apply: (text, renderer) => /* transformed text */ text
};
```

## `RenderContext`

| Member | Purpose |
| --- | --- |
| `currentMacros` | Current KaTeX macro definitions |
| `metadata` | Parsed document metadata, when available |
| `bibEntries` | Current bibliography entries |
| [`PreprocessRule.apply`](../legacy/apply) | Transform one block in the legacy rule sequence |
| [`protectHtml`](../legacy/protect-html) | Hide trusted generated HTML from Markdown |
| [`renderInline`](../legacy/render-inline) | Run Markdown inline rendering |
| [`resolveCitation`](../legacy/resolve-citation) | Assign or reuse a citation number |
| [`getCitedKeys`](../legacy/get-cited-keys) | Read citation keys seen so far |

Legacy rules operate on source text and therefore commonly use the [balanced source readers](../source/replace-latex-command-calls). They do not receive AST nodes and do not run in AST mode.

## Related APIs

- [Rendering Rules Tutorial](../../rules)
- [`replaceLatexCommandCalls`](../source/replace-latex-command-calls)
- [`renderInlineLatexHtml`](../rendering/render-inline-latex-html)
- [Call Relationships](../call-relationships)
