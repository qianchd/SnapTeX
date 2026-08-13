# `argumentText`

Flattens an AST argument to readable text.

## Signature

```ts
function argumentText(argument: SnaptexAstArgument | undefined): string
```

## Returns

The recursively concatenated text content of argument nodes, or an empty string when the argument is absent. AST whitespace nodes become ordinary spaces.

## Call relationships

- **Called after:** [`readRequiredMacroArgument`](./read-required-macro-argument) or [`readOptionalMacroArgument`](./read-optional-macro-argument).
- **Called by:** [`readAstCommandArguments`](./read-ast-command-arguments).
- **Does not:** render nested LaTeX to HTML.

```ts
const label = argumentText(readRequiredMacroArgument(node));
```

Use [`renderChildren`](./render-children) when nested structure and formatting must be preserved.

## See also

- [`renderChildren`](./render-children)
