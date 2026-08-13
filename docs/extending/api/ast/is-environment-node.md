# `isEnvironmentNode`

Checks whether an unknown value is an AST environment or math-environment node.

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
- **Called by:** AST rule `match` callbacks and structural visitors.
- **Enables:** TypeScript narrowing to `SnaptexAstEnvironment`.

```ts
match: input => isEnvironmentNode(input.node, 'notice')
```

## See also

- [`environmentName`](./environment-name)
- [`isMacroNode`](./is-macro-node)
