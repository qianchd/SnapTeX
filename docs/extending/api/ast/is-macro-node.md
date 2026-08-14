# `isMacroNode`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Checks whether an unknown value is a LaTeX AST macro node and optionally matches its name. It is the usual narrow `match` predicate for a command rule.

## Signature

```ts
function isMacroNode(node: unknown, name?: string): node is SnaptexAstMacro
```

## Returns

`true` only when `node` is an object with `type === 'macro'`, string `content`, and, when supplied, the requested command `name`.

## Call relationships

- **Called by:** AST rule `match` callbacks and AST readers.
- **Enables:** TypeScript narrowing to `SnaptexAstMacro`.
- **Does not:** inspect or validate command arguments.

```ts
match: input => isMacroNode(input.node, 'badge')
```

Command names do not include the leading backslash.

## See also

- [`readAstCommandArguments`](./read-ast-command-arguments)
- [`isEnvironmentNode`](./is-environment-node)
