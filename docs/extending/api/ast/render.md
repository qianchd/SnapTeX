# `AstRenderRule.render`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Renders a node accepted by the rule's `match` callback. You implement this callback; the AST walker supplies both arguments and consumes its result.

## Signature

```ts
render(
    input: AstRenderInput,
    context: AstRenderContext
): AstRenderResult | undefined
```

## Returns

`{ html, consumedNodes? }` to claim the node, or `undefined` to let later rules try. `consumedNodes` defaults to `1`.

`html` is final preview HTML. `consumedNodes` counts sibling-list entries beginning at `input.index`, including the current node; it is not the number of child nodes rendered.

## Call relationships

- **Called by:** the AST walker after [`match`](./match) returns true.
- **Usually calls:** [`readAstCommandArguments`](./read-ast-command-arguments), [`input.renderChildren`](./render-children), or an `AstRenderContext` method.
- **Output goes directly to:** preview HTML; it does not pass through Markdown.

```text
accepted node -> render(input, context) -> result: append HTML and advance walker
                                      -> undefined: try the next rule
```

```ts
render: (input, context) => {
    const args = readAstCommandArguments(input, 1);
    const content = args.requiredArgs[0];
    return content === undefined ? undefined : {
        html: `<span>${context.escapeHtml(content)}</span>`,
        consumedNodes: args.consumedNodes
    };
}
```

Always escape plain source values or render existing AST children. Do not use legacy protection tokens in AST output.

## See also

- [`AstRenderRule.match`](./match)
- [AST rule contract](../contracts/ast-rules)
