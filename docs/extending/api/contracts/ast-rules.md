# AST Rule Contract

<!--@include: ../../../.vitepress/partials/api-context.md-->

An `AstRenderRule` claims parsed nodes and returns HTML directly. Use it when node type, nested structure, or exact AST ownership is more reliable than source-text replacement.

```ts
type AstRenderRule = (
    input: AstRenderInput,
    context: AstRenderContext
) => AstRenderResult | undefined;

interface AstRenderResult {
    html: string;
    consumedNodes?: number;
}
```

## Ownership

Rules are called in registry array order. Each [rule callback](../ast/render) first checks whether it handles the current node. The first callback that returns a result owns it; returning `undefined` lets later rules try. Unclaimed nodes use the AST fallback renderer.

`consumedNodes` defaults to `1`. Set it to the value returned by [`readAstCommandArguments`](../ast/read-ast-command-arguments) when detached sibling groups were consumed.

Keep the node check at the start of the rule, before reading arguments or creating output. This gives TypeScript the correct narrowed node type without repeating a separate match predicate.

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

Use `input.renderChildren` for nodes that already exist. Use `input.renderSource` only for generated LaTeX that must be parsed again.

## Related APIs

- [`defineAstRenderRule`](../registry/define-ast-render-rule)
- [`readAstCommandArguments`](../ast/read-ast-command-arguments)
- [Call Relationships](../call-relationships)
