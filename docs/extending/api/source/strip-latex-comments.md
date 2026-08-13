# `stripLatexComments`

Removes or masks unescaped LaTeX line comments.

## Signature

```ts
function stripLatexComments(
    text: string,
    options?: { mode?: 'remove' | 'mask' }
): string
```

## Modes

| Mode | Result |
| --- | --- |
| `remove` (default) | Deletes full comment lines and inline comments for preview text |
| `mask` | Replaces each comment body with `%`, preserving line count and TeX comment semantics |

## Returns

A new source string. Escaped `\\%` sequences are preserved.

## Call relationships

- **Called by:** the early legacy comment-cleanup rule and source-stable metadata/scanner paths.
- **Independent from:** [`skipLatexWhitespace`](./skip-latex-whitespace), which advances an index without rewriting text.

```ts
stripLatexComments('Text % hidden\nNext');
// 'Text Next'

stripLatexComments('Text % hidden\nNext', { mode: 'mask' });
// 'Text %\nNext'
```

Choose `mask` when offsets or line mappings must remain meaningful.

## See also

- [`skipLatexWhitespace`](./skip-latex-whitespace)
