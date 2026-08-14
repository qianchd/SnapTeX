# `skipLatexWhitespace`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Advances an index across LaTeX whitespace and complete `%` line comments. It is a source-reader primitive, not a document cleanup pass.

## Signature

```ts
function skipLatexWhitespace(text: string, index: number): number
```

## Parameters

| Parameter | Description |
| --- | --- |
| `text` | Source being read |
| `index` | Starting offset |

## Returns

The first offset that is neither whitespace nor a line comment, or `text.length` when no token remains.

## Call relationships

- **Called by:** [`readLatexGroup`](./read-latex-group) and [`readLatexCommandAt`](./read-latex-command-at).
- **Does not:** alter source or validate the token at the returned offset.

```ts
const tokenStart = skipLatexWhitespace(source, commandEnd);
```

Escaped percent signs are not a supported starting comment token for this reader because it only enters comment skipping when the current character itself is `%`.

## See also

- [`stripLatexComments`](./strip-latex-comments)
- [`readLatexGroup`](./read-latex-group)
