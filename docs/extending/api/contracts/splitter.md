# Splitter Contract

<!--@include: ../../../.vitepress/partials/api-context.md-->

Splitter settings control block boundaries before rendering. Both backends read
the same registry fields, but they do not run the same pipeline: legacy uses
one coarse split, while AST mode refines selected coarse blocks structurally.

## Backend pipelines

```text
legacy: source -> LatexBlockSplitter -> final block spans

AST:    source -> LatexBlockSplitter -> transparent-wrapper adjustment
               -> selective AST refinement -> final block spans
```

The AST path deliberately starts with the legacy splitter. Its inexpensive
environment, brace, paragraph, and malformed-input recovery logic provides
stable coarse spans. AST parsing then runs only for coarse spans that contain a
transparent environment, a refinable context wrapper, or an
unprotected block longer than `maxBlockLines`.

On an edit, AST mode runs the coarse splitter again, compares coarse-block
hashes, reuses refined spans before and after the changed range, and reparses
only changed coarse blocks. The registry describes structural policy; it does
not replace or reorder this fixed two-layer pipeline.

## `SplitterConfig`

```ts
interface SplitterConfig {
    maxBlockLines: number;
    maxNoEmergencySplitLines: number;
}
```

`maxBlockLines` is the ordinary coarse emergency-split threshold. AST mode also
uses it to decide whether an otherwise ordinary coarse block needs structural
refinement. `maxNoEmergencySplitLines` gives protected constructs a larger
malformed-input recovery window and bounds transparent-wrapper merging and AST
safety splitting.

## `SplitterRule`

| `kind` | Coarse splitter | AST refinement |
| --- | --- | --- |
| `ignored-env` | Excludes the environment from coarse stack tracking | Not read directly |
| `transparent-env` | Not read directly | Recurses into the environment; optionally preserves its wrapper text |
| `split-env` | Starts an explicit coarse block | Starts a structural block while traversing parsed nodes |
| `no-emergency-split-env` | Extends the emergency-split budget inside the environment | Prevents long protected blocks from being selected only because of length |
| `context-wrapper` | Recognizes the wrapper macro with a lightweight source scan and extends its emergency-split budget | Finds the exact content in the parsed node, refines it, and restores the wrapper around resulting blocks |
| `emergency-split-end-env` | Permits malformed-input recovery after a recognized environment end | Not read directly |

Every rule has a diagnostic `name` and an `envPattern` or `macroPattern`
according to its kind.

Splitter rules describe structure; they do not render content. Add them only
when a construct's boundaries cannot be handled correctly by existing rules.

Use `context-wrapper` for macros that make surrounding source necessary to
render independently split content. Set `content` to `group-remainder` when
the payload follows a declaration macro inside the same group:

```ts
{
    name: 'declaration-style-groups',
    kind: 'context-wrapper',
    macroPattern: /^(?:color|bf|it|sf|rm|tt)$/,
    content: 'group-remainder'
}
```

This declaration matches the bare macro name `color` in source shaped like:

```latex
{\color{blue} first paragraph

second paragraph}
```

The payload is the remainder of the enclosing group after the complete
`\color{blue}` declaration. `macroPattern` does not match the opening `{` and
does not need to describe the color argument.

For a function-style wrapper, identify the zero-based required argument that
contains its payload:

```ts
{
    name: 'resizebox',
    kind: 'context-wrapper',
    macroPattern: /^resizebox$/,
    content: { requiredArgument: 2 }
}
```

This declaration matches the bare macro name `resizebox` in:

```latex
\resizebox{\linewidth}{!}{payload}
```

Required arguments are zero-based, so `requiredArgument: 2` selects the third
required argument, `payload`.

`macroPattern` receives the bare macro name without the leading backslash. The
coarse splitter uses this declaration only to protect a likely wrapper from
premature emergency splitting; it does not parse an AST. AST refinement later
uses the same declaration to locate either the enclosing-group payload or the
selected required argument and to preserve the corresponding prefix and
suffix.

## Related APIs

- [Registry contract](./registry)
- [Extension Model](../../index)
