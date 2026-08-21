# `isEnvironmentNode`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Checks whether an unknown value is an AST environment or math-environment node. Use it at the start of an environment rule's `render` callback.

## Signature

```ts
function isEnvironmentNode(
    node: unknown,
    name?: string
): node is SnaptexAstEnvironment
```

## Returns

`true` for `environment` or `mathenv` nodes with a readable environment name. When `name` is supplied, the names must match exactly.

## Call relationships

- **Calls:** [`environmentName`](./environment-name).
- **Called by:** AST rule `render` callbacks and structural visitors.
- **Enables:** TypeScript narrowing to `SnaptexAstEnvironment`.

```ts
render: input => {
    if (!isEnvironmentNode(input.node, 'notice')) { return undefined; }
    return { html: input.renderChildren(input.node.content ?? []) };
}
```

## See also

- [`environmentName`](./environment-name)
- [`isMacroNode`](./is-macro-node)
