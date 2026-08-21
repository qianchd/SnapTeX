# `replaceLatexCommandCalls`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Finds and replaces valid calls to one or more named LaTeX commands while preserving unmatched source. Use it for command-wide replacement in legacy rules; use `readLatexCommandAt` when you already know the exact source position to inspect.

## Signature

```ts
function replaceLatexCommandCalls(
    text: string,
    rules: LatexCommandReplacementRule | LatexCommandReplacementRule[]
): string
```

```ts
interface LatexCommandReplacementRule {
    name: string | readonly string[];
    requiredArgs?: number;
    optionalArgs?: number;
    allowStar?: boolean;
    render(call: LatexCommandCall): string;
}
```

## Parameters

| Value | Supplied by | Meaning |
| --- | --- | --- |
| `text` | Calling rule | Source to scan |
| `rules` | Calling rule | Command names, argument counts, and replacement callbacks |
| `call` | `replaceLatexCommandCalls` | One validated command with balanced groups and source offsets |

Access brace content with `call.requiredArgs[index].content` and bracket content with `call.optionalArgs[index].content`.

## Returns

The transformed string. Commands with missing/unbalanced required arguments are preserved and do not invoke `render`.

## Call relationships

- **Searches for:** configured command names.
- **Calls:** [`readLatexCommandAt`](./read-latex-command-at) for validation and argument reading.
- **Usually called by:** a legacy `PreprocessRule.apply` callback.

```text
block text -> command search -> readLatexCommandAt -> render(call) -> replaced block text
```

## Example

```ts
const output = replaceLatexCommandCalls(source, {
    name: 'badge',
    requiredArgs: 1,
    render: call => renderer.protectHtml(
        'badge',
        `<span>${escapeHtml(call.requiredArgs[0].content)}</span>`,
        'inline'
    )
});
```

Use one rule with `name: ['aliasA', 'aliasB']` when aliases have identical syntax and rendering. Use separate rules when argument counts or behavior differ.

The nested `render(call)` function is a replacement callback owned by this helper. It is unrelated to the `AstRenderRule` callback.

## See also

- [`readLatexCommandAt`](./read-latex-command-at)
- [`renderer.protectHtml`](../legacy/protect-html)
