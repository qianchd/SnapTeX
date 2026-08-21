# `AstRenderRule`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Checks and renders the current AST node. You implement this callback; the AST walker supplies both arguments and consumes its result.

## Signature

```ts
type AstRenderRule = (
    input: AstRenderInput,
    context: AstRenderContext
) => AstRenderResult | undefined
```

## Returns

`{ html, consumedNodes? }` to claim the node, or `undefined` to let later rules try. `consumedNodes` defaults to `1`.

`html` is final preview HTML. `consumedNodes` counts sibling-list entries beginning at `input.index`, including the current node; it is not the number of child nodes rendered.

## Call relationships

- **Called by:** the AST walker for each rule in registry order until one returns a result.
- **Usually calls:** [`readAstCommandArguments`](./read-ast-command-arguments), [`input.renderChildren`](./render-children), or an `AstRenderContext` method.
- **Output goes directly to:** preview HTML; it does not pass through Markdown.

```text
node -> rule(input, context) -> result: append HTML and advance walker
                            -> undefined: try the next rule
```

```ts
const RULE = defineAstRenderRule((input, context) => {
    if (!isMacroNode(input.node, 'badge')) {
        return undefined;
    }
    const args = readAstCommandArguments(input, 1);
    const content = args.requiredArgs[0];
    return content === undefined ? undefined : {
        html: `<span>${context.escapeHtml(content)}</span>`,
        consumedNodes: args.consumedNodes
    };
});
```

Always escape plain source values or render existing AST children. Do not use legacy protection tokens in AST output.

## See also

- [`isMacroNode`](./is-macro-node)
- [AST rule contract](../contracts/ast-rules)
