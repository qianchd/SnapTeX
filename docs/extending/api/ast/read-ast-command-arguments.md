# `readAstCommandArguments`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Reads optional and required arguments for the current AST macro, including detached sibling groups. Use it from an `AstRenderRule` when a command's arguments may not all be attached to the macro node by the parser.

## Signature

```ts
function readAstCommandArguments(
    input: AstNodeLocation,
    requiredArgCount = 1
): AstCommandArguments
```

```ts
interface AstCommandArguments {
    requiredArgs: string[];
    optionalArgs: string[];
    requiredArgNodes: SnaptexAstNode[][];
    optionalArgNodes: SnaptexAstNode[][];
    consumedNodes: number;
}
```

## Behavior

The function first reads arguments attached to `input.node`. If fewer required arguments are available, it skips sibling whitespace, reads detached bracket groups, then reads detached brace-group nodes until `requiredArgCount` is met.

The helper returns both plain argument text and the corresponding node arrays. In a normal `AstRenderRule`, pass an entry such as `requiredArgNodes[0]` to `input.renderChildren` when preserving parsed nested formatting is essential. In an `AstMathRule`, pass it to `input.sourceContent` to preserve the exact original TeX.

## Call relationships

- **Called by:** `AstRenderRule` callbacks and the math-rule dispatcher.
- **Reads:** arguments attached to the macro plus detached sibling groups.
- **Return feeds:** rendered argument content and `consumedNodes` in either AST rule type.

```text
AstRenderInput -> attached arguments + following sibling groups
               -> requiredArgs / optionalArgs / consumedNodes
               -> AstRenderResult
```

```ts
const args = readAstCommandArguments(input, 1);
if (args.requiredArgs[0] === undefined) return undefined;
return { html: context.escapeHtml(args.requiredArgs[0]), consumedNodes: args.consumedNodes };
```

For a non-macro node, it returns empty argument arrays and `consumedNodes: 1`.

## See also

- [AST rule contract](../contracts/ast-rules)
- [`renderChildren`](./render-children)
