# `readLatexGroup`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Reads one balanced brace or bracket group, including nested groups and escaped delimiters. Use it when reading a group at a known offset; use `replaceLatexCommandCalls` for command-wide search and replacement.

## Signature

```ts
function readLatexGroup(
    text: string,
    startIndex: number,
    options?: {
        delimiter?: 'brace' | 'bracket';
        skipWhitespace?: boolean;
    }
): LatexGroup | undefined
```

## Returns

```ts
interface LatexGroup {
    content: string;
    start: number;
    end: number;
    open: '{' | '[';
    close: '}' | ']';
}
```

`end` is exclusive. The function returns `undefined` when the expected opening delimiter is absent or the group is unclosed.

## Call relationships

- **Calls:** [`skipLatexWhitespace`](./skip-latex-whitespace) unless `skipWhitespace` is `false`.
- **Called by:** [`readLatexCommandAt`](./read-latex-command-at) and metadata/structure readers.

```ts
const group = readLatexGroup('  {outer {inner}}', 0);
// group.content === 'outer {inner}'
```

Use bracket mode for optional arguments:

```ts
readLatexGroup(source, index, { delimiter: 'bracket' });
```

## See also

- [`readLatexCommandAt`](./read-latex-command-at)
- [`replaceLatexCommandCalls`](./replace-latex-command-calls)
