# `defineAstRenderRule`

Preserves an AST rule unchanged while providing contextual TypeScript typing.

## Signature

```ts
function defineAstRenderRule(rule: AstRenderRule): AstRenderRule
```

## Parameters

| Parameter | Description |
| --- | --- |
| `rule` | AST matcher and renderer definition |

## Returns

The same rule object. The helper does not register, sort, clone, or wrap it.

## Call relationships

- **Called by:** rule declarations in `src/rules.ts`.
- **Registered through:** `RuleRegistry.astRenderRules`.
- **Executed by:** the AST renderer in array order.

## Example

```ts
const RULE = defineAstRenderRule({
    name: 'ast-badge',
    match: input => isMacroNode(input.node, 'badge'),
    render: (input, context) => {
        const args = readAstCommandArguments(input, 1);
        const content = args.requiredArgs[0];
        return content === undefined ? undefined : {
            html: `<span>${context.escapeHtml(content)}</span>`,
            consumedNodes: args.consumedNodes
        };
    }
});
```

Prefer [`readAstCommandArguments`](../ast/read-ast-command-arguments) for commands with arguments.

## See also

- [AST rule contract](../contracts/ast-rules)
- [`defineRuleRegistry`](./define-rule-registry)
