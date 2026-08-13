# `readOptionalMacroArgument`

Reads an argument attached to an AST macro whose opening delimiter is `[`.

## Signature

```ts
function readOptionalMacroArgument(
    node: SnaptexAstMacro,
    index = 0
): SnaptexAstArgument | undefined
```

## Returns

The indexed attached optional argument or `undefined`. Detached sibling brackets are not searched.

## Call relationships

- **Called by:** [`readAstCommandArguments`](./read-ast-command-arguments) and direct AST rules.
- **Often followed by:** [`argumentText`](./argument-text).

```ts
const shortTitle = argumentText(readOptionalMacroArgument(node));
```

## See also

- [`readRequiredMacroArgument`](./read-required-macro-argument)
- [`readAstCommandArguments`](./read-ast-command-arguments)
