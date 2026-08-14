# `context.renderCitation`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Renders a supported citation command using the current bibliography and citation state. Prefer it over rebuilding cite/citep/citet formatting inside a custom AST rule.

## Signature

```ts
context.renderCitation(
    command: string,
    keys: readonly string[],
    options: { pre?: string; post?: string }
): string
```

## Parameters

`command` is the LaTeX command name without its backslash. `keys` contains parsed citation keys. `pre` and `post` represent optional citation notes.

## Returns

Direct citation HTML appropriate for the configured command and current bibliography entries.

## Call relationships

- **Called by:** AST citation-family rules.
- **Uses:** bibliography entries plus [`context.resolveCitation`](./context-resolve-citation).
- **Updates:** the current cited-key list.

```ts
const html = context.renderCitation('citep', ['smith2024'], {
    pre: 'see',
    post: 'p. 4'
});
```

## See also

- [`context.resolveCitation`](./context-resolve-citation)
- [`context.getCitedKeys`](./context-get-cited-keys)
