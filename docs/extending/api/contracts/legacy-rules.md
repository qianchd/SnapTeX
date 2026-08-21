# Legacy Rule Contract

<!--@include: ../../../.vitepress/partials/api-context.md-->

A `PreprocessRule` transforms one block of LaTeX source before Markdown rendering. Use it when the legacy backend can recognize the feature from source text without structural AST traversal.

```ts
interface PreprocessRule {
    priority: number;
    apply(text: string, renderer: RenderContext): string;
}
```

## Lifecycle

1. `defineRuleRegistry` sorts legacy rules by ascending `priority`.
2. `SmartRenderer` passes the current block through every [`apply`](../legacy/apply) callback.
3. Markdown-it renders the transformed text with raw HTML disabled.
4. SnapTeX restores HTML registered with `renderer.protectHtml`.

The callback's return value is therefore usually one of three forms:

| Return shape | Use |
| --- | --- |
| Unchanged `text` | The rule does not apply |
| Transformed LaTeX/Markdown-compatible text | A later rule or Markdown should continue processing it |
| Text containing protected tokens | The rule generated trusted HTML that must survive Markdown |

```ts
const RULE: PreprocessRule = {
    priority: 200,
    apply: (text, _renderer) => /* transformed text */ text
};
```

The `_renderer` parameter is present because SnapTeX always supplies the full
`apply(text, renderer)` interface. Its underscore only says that this minimal
example does not use the context.

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

`priority` controls ordering; it does not select commands. Source matching belongs inside `apply`, normally through `replaceLatexCommandCalls` or another shared reader.

## Related APIs

- [Rendering Rules Tutorial](../../rules)
- [`replaceLatexCommandCalls`](../source/replace-latex-command-calls)
- [`renderInlineLatexHtml`](../rendering/render-inline-latex-html)
- [Call Relationships](../call-relationships)
