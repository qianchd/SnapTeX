# `AstRenderRule.render`

Renders a node accepted by the rule's `match` callback.

## Signature

```ts
render(
    input: AstRenderInput,
    context: AstRenderContext
): AstRenderResult | undefined
```

## Returns

`{ html, consumedNodes? }` to claim the node, or `undefined` to let later rules try. `consumedNodes` defaults to `1`.

## Call relationships

- **Called by:** the AST walker after [`match`](./match) returns true.
- **Usually calls:** [`readAstCommandArguments`](./read-ast-command-arguments), [`input.renderChildren`](./render-children), or an `AstRenderContext` method.
- **Output goes directly to:** preview HTML; it does not pass through Markdown.

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
