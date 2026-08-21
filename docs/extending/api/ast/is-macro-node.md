# `isMacroNode`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Checks whether an unknown value is a LaTeX AST macro node and optionally matches its name. Use it at the start of a command rule.

## Signature

```ts
function isMacroNode(node: unknown, name?: string): node is SnaptexAstMacro
```

## Returns

`true` only when `node` is an object with `type === 'macro'`, string `content`, and, when supplied, the requested command `name`.

## Call relationships

- **Called by:** AST rules and AST readers.
- **Enables:** TypeScript narrowing to `SnaptexAstMacro`.
- **Does not:** inspect or validate command arguments.

```ts
const RULE = defineAstRenderRule((input, context) => {
    if (!isMacroNode(input.node, 'badge')) { return undefined; }
    // input.node is a SnaptexAstMacro here.
});
```

Command names do not include the leading backslash.

## See also

- [`readAstCommandArguments`](./read-ast-command-arguments)
- [`isEnvironmentNode`](./is-environment-node)
