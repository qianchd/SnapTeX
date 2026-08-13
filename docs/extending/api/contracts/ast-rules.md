# AST Rule Contract

An `AstRenderRule` claims parsed nodes and returns HTML directly.

```ts
interface AstRenderRule {
    name: string;
    match(input: AstRenderInput): boolean;
    render(input: AstRenderInput, context: AstRenderContext): AstRenderResult | undefined;
}

interface AstRenderResult {
    html: string;
    consumedNodes?: number;
}
```

## Ownership

Rules are checked in registry array order. The first [`match`](../ast/match) that accepts a node and whose [`render`](../ast/render) method returns a result owns it. Returning `undefined` lets later rules try. Unclaimed nodes use the AST fallback renderer.

`consumedNodes` defaults to `1`. Set it to the value returned by [`readAstCommandArguments`](../ast/read-ast-command-arguments) when detached sibling groups were consumed.

## `AstRenderInput`

| Member | Purpose |
| --- | --- |
| `node` | Current parsed node |
| `siblings` | Nodes in the same parent list |
| `index` | Current position in `siblings` |
| [`renderChildren`](../ast/render-children) | Render existing parsed child nodes |
| [`renderSource`](../ast/render-source) | Parse and render generated LaTeX source |

## `AstRenderContext`

The context carries document state plus safe output methods. Its callable members each have a dedicated page under **AST Functions** in the sidebar.

AST output does not pass through Markdown. Return valid, escaped HTML and use context rendering methods for math, references, citations, and images.

## Related APIs

- [`defineAstRenderRule`](../registry/define-ast-render-rule)
- [`readAstCommandArguments`](../ast/read-ast-command-arguments)
- [Call Relationships](../call-relationships)
