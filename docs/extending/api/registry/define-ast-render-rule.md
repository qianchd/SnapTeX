# `defineAstRenderRule`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Preserves an AST rule unchanged while providing contextual TypeScript typing. Use it while declaring a rule in `src/rules.ts`; adding the result to `astRenderRules` is the separate registration step.

## Signature

```ts
function defineAstRenderRule(rule: AstRenderRule): AstRenderRule
```

## Parameters

| Parameter | Description |
| --- | --- |
| `rule` | AST render callback |

## Returns

The same callback. The helper does not register, sort, clone, or wrap it.

## Call relationships

- **Called by:** rule declarations in `src/rules.ts`.
- **Registered through:** `RuleRegistry.astRenderRules`.
- **Executed by:** the AST renderer in array order.

```text
callback -> defineAstRenderRule -> astRenderRules registration -> AST walker
```

## Example

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

Prefer [`readAstCommandArguments`](../ast/read-ast-command-arguments) for commands with arguments.

## See also

- [AST rule contract](../contracts/ast-rules)
- [`defineRuleRegistry`](./define-rule-registry)
