# `input.renderChildren`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Renders an existing list of parsed AST nodes with the current rules and context. This is the default choice for an environment or group body that already exists in the AST.

## Signature

```ts
input.renderChildren(nodes: readonly SnaptexAstNode[]): string
```

## Returns

HTML produced by walking the supplied nodes. The nodes are reused; no parser runs again.

## Call relationships

- **Provided by:** the AST walker on each `AstRenderInput`.
- **Recursively calls:** the current AST rule list.
- **Shares:** current metadata, citations, macros, and image renderer.

```text
existing child nodes -> current AST walker/rules -> HTML
```

```ts
const body = Array.isArray(input.node.content)
    ? input.renderChildren(input.node.content)
    : '';
return { html: `<aside>${body}</aside>` };
```

Use this for ordinary child content. Use [`renderSource`](./render-source) only when you have generated or reconstructed LaTeX source rather than existing nodes.

## See also

- [`input.renderSource`](./render-source)
- [AST rule contract](../contracts/ast-rules)
