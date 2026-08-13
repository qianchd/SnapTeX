# `readAstCommandArguments`

Reads optional and required arguments for the current AST macro, including detached sibling groups.

## Signature

```ts
function readAstCommandArguments(
    input: AstRenderInput,
    requiredArgCount = 1
): AstCommandArguments
```

```ts
interface AstCommandArguments {
    requiredArgs: string[];
    optionalArgs: string[];
    consumedNodes: number;
}
```

## Behavior

The function first reads arguments attached to `input.node`. If fewer required arguments are available, it skips sibling whitespace, reads detached bracket groups, then reads detached brace-group nodes until `requiredArgCount` is met.

## Call relationships

- **Called by:** `AstRenderRule.render` for macro commands.
- **Calls:** [`readOptionalMacroArgument`](./read-optional-macro-argument), [`readRequiredMacroArgument`](./read-required-macro-argument), and [`argumentText`](./argument-text).
- **Return feeds:** `AstRenderResult.consumedNodes`.

```ts
const args = readAstCommandArguments(input, 1);
if (args.requiredArgs[0] === undefined) return undefined;
return { html: context.escapeHtml(args.requiredArgs[0]), consumedNodes: args.consumedNodes };
```

For a non-macro node, it returns empty argument arrays and `consumedNodes: 1`.

## See also

- [AST rule contract](../contracts/ast-rules)
- [`renderChildren`](./render-children)
