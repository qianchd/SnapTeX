# `readRequiredMacroArgument`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Reads an argument attached to an AST macro whose opening delimiter is `{`. Use it when the parser is known to attach the command arguments; use `readAstCommandArguments` for unknown commands with detached sibling groups.

## Signature

```ts
function readRequiredMacroArgument(
    node: SnaptexAstMacro,
    index = 0
): SnaptexAstArgument | undefined
```

## Parameters

`index` counts only attached required arguments, not optional arguments.

## Returns

The matching AST argument or `undefined`. It does not search sibling nodes for a detached group.

## Call relationships

- **Called by:** [`readAstCommandArguments`](./read-ast-command-arguments) and direct AST rules.
- **Often followed by:** [`argumentText`](./argument-text).

```ts
const title = argumentText(readRequiredMacroArgument(node));
```

Use [`readAstCommandArguments`](./read-ast-command-arguments) when unknown commands may have detached sibling groups.

## See also

- [`readOptionalMacroArgument`](./read-optional-macro-argument)
