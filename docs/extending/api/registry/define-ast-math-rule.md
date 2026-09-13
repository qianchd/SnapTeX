# `defineAstMathRule`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Provides contextual TypeScript typing for one command rule used inside AST math. The function returns the same rule object; the rule starts running only after it is added to `SNAP_TEX_RULES.astMathRules`.

## Signature

```ts
function defineAstMathRule(rule: AstMathRule): AstMathRule
```

## Rule shape

```ts
interface AstMathRule {
    readonly commands: readonly string[];
    apply(input: AstMathRuleInput, context: AstRenderContext): AstMathRuleResult | undefined;
}
```

- `commands` lets the existing block AST decide whether the formula needs a local parse.
- `apply` receives the matching macro, parsed arguments, exact local source access, and the normal AST render context.
- Returning `undefined` lets the next rule for the same command try.
- Rules run in array order; there is no numeric priority.

See [Commands inside math](../../rules#commands-inside-math) for a complete declaration and registration example.

