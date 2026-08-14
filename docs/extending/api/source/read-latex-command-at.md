# `readLatexCommandAt`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Reads one named LaTeX command at a specified source position. Use it when a caller already controls the scan position; it deliberately does not search the remaining source.

## Signature

```ts
function readLatexCommandAt(text, startIndex, options): LatexCommandCall | undefined
```

```ts
interface LatexCommandReadOptions {
    name: string;
    requiredArgs?: number;
    optionalArgs?: number;
    allowStar?: boolean;
    skipWhitespace?: boolean;
}
```

## Behavior

By default, leading whitespace and comments are skipped. The function then requires exactly `\\${name}` at that location. It does **not** search the rest of the string.

Required groups must all be present and balanced. Optional groups are read up to the requested count and may be absent. A star is accepted only when `allowStar` is true.

## Returns

The command name, source offsets, star flag, and arrays of optional and required [`LatexGroup`](./read-latex-group) values. Returns `undefined` on a name boundary mismatch or malformed required argument.

## Call relationships

- **Calls:** [`skipLatexWhitespace`](./skip-latex-whitespace) and [`readLatexGroup`](./read-latex-group).
- **Called by:** [`replaceLatexCommandCalls`](./replace-latex-command-calls) and targeted source readers.

```ts
const call = readLatexCommandAt(source, index, {
    name: 'href',
    requiredArgs: 2,
    allowStar: false
});
```

## See also

- [`replaceLatexCommandCalls`](./replace-latex-command-calls)
