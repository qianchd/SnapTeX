# `environmentName`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Reads an environment name from the shapes produced by the unified-latex parser. Use it when only the name is needed; use `isEnvironmentNode` when the rule also needs type narrowing.

## Signature

```ts
function environmentName(node: unknown): string | undefined
```

## Returns

The string name when `node.env` is either a string or an object with string `content`; otherwise `undefined`.

## Call relationships

- **Called by:** [`isEnvironmentNode`](./is-environment-node), verbatim guards, and environment rules.
- **Does not:** require the node itself to have an environment type.

```ts
const name = environmentName(input.node);
if (name === 'notice') { /* ... */ }
```

Prefer [`isEnvironmentNode`](./is-environment-node) when you need both validation and TypeScript narrowing.

## See also

- [`isEnvironmentNode`](./is-environment-node)
