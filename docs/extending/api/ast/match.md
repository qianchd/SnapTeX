# `AstRenderRule.match`

Performs the cheap ownership check for the current AST node.

## Signature

```ts
match(input: AstRenderInput): boolean
```

## Returns

`true` when the rule wants its [`render`](./render) callback to run for this node. A true result does not guarantee ownership: `render` may still return `undefined`.

## Call relationships

- **Called by:** the AST walker in registry array order.
- **Usually calls:** [`isMacroNode`](./is-macro-node), [`isEnvironmentNode`](./is-environment-node), or another inexpensive node guard.
- **When false:** the walker immediately tries the next rule.

```ts
match: input => isMacroNode(input.node, 'badge')
```

Keep argument parsing and HTML generation in `render`; `match` runs for many nodes and should stay narrow and inexpensive.

## See also

- [`AstRenderRule.render`](./render)
- [AST rule contract](../contracts/ast-rules)
