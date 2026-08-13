# `input.renderSource`

Parses generated LaTeX source and renders the resulting AST with the current rules.

## Signature

```ts
input.renderSource(source: string): string
```

## Returns

Rendered HTML. If parsing fails, SnapTeX falls back to its inline LaTeX renderer. Generated-source recursion is capped at eight levels.

## Call relationships

- **Provided by:** the AST walker.
- **Calls:** the loaded unified-latex parser, then the AST rule walker.
- **Creates:** source readers scoped to the generated string.

```ts
const expanded = input.renderSource('\\textbf{Generated text}');
```

This function does additional parsing. Prefer [`renderChildren`](./render-children) for nodes already present in the AST.

## See also

- [`input.renderChildren`](./render-children)
- [Call Relationships](../call-relationships)
