# Rule API reference

This page documents the source-level interfaces recommended for custom rules in `src/rules.ts`. It distinguishes values supplied by SnapTeX from values created by the rule, so callback parameters do not appear from nowhere.

Choose the section for the backend you are extending. Legacy rules and AST rules are independent APIs; neither is a required companion to the other.

::: info Scope
SnapTeX does not yet publish a separate rules package with semantic-version guarantees. The APIs below are the supported extension surface inside this repository. Other exported utilities may be used by built-in modules but are not automatically part of the rule API.
:::

## Registry API

### `defineRuleRegistry(registry)`

```ts
defineRuleRegistry(registry: RuleRegistry): RuleRegistry
```

Creates the registry passed to `LatexDocument` and `SmartRenderer`. It copies each rule array and sorts `renderRules` by ascending `priority`. AST rules retain their array order.

The required fields are:

| Field | Element type | Consumer |
| --- | --- | --- |
| `metadataExtractors` | `MetadataExtractor` | document parser |
| `renderRules` | `PreprocessRule` | legacy renderer |
| `astRenderRules` | `AstRenderRule` | AST renderer |
| `blockDependencyRules` | `BlockDependencyRule` | incremental refresh logic |
| `splitterConfig` | `SplitterConfig` | block splitter |
| `splitterRules` | `SplitterRule` | block splitter |

### `defineAstRenderRule(rule)`

```ts
defineAstRenderRule(rule: AstRenderRule): AstRenderRule
```

Returns the supplied rule unchanged. Its purpose is contextual TypeScript checking when defining an AST rule inline.

### `defineBlockDependencyRule(rule)`

```ts
defineBlockDependencyRule(rule: BlockDependencyRule): BlockDependencyRule
```

Returns the supplied dependency rule unchanged while providing contextual TypeScript checking.

## Legacy rendering API

### `PreprocessRule`

```ts
interface PreprocessRule {
    name: string;
    priority: number;
    apply(text: string, renderer: RenderContext): string;
}
```

SnapTeX calls `apply` once for each rule, passing:

- `text`: the current block after all lower-priority rules have transformed it;
- `renderer`: document services owned by `SmartRenderer`.

The return value becomes `text` for the next rule. After the final rule, SnapTeX sends the result through Markdown-it and then restores protected HTML.

### `RenderContext`

SnapTeX creates this object and supplies it as the second `apply` argument.

| Member | Meaning |
| --- | --- |
| `currentMacros` | KaTeX macro definitions extracted from the current document. |
| `metadata` | Current structured preamble metadata, when available. |
| `bibEntries` | Parsed bibliography entries indexed by citation key. |
| `protectHtml(namespace, html, mode?)` | Stores trusted generated HTML behind a temporary token until Markdown finishes. |
| `renderInline(markdown)` | Renders Markdown inline. It is not a general LaTeX renderer. |
| `resolveCitation(key)` | Returns the stable one-based citation number for a key in this render lifecycle. |
| `getCitedKeys()` | Returns citation keys already collected for the document. |

#### `protectHtml(namespace, html, mode?)`

```ts
renderer.protectHtml(
    namespace: string,
    html: string,
    mode: 'inline' | 'block' = 'block'
): string
```

The return value is a temporary text token, not the original HTML. Return that token from the rule; SnapTeX restores the HTML after Markdown rendering.

- `namespace` identifies the token while debugging. It does not select CSS or another rule.
- `html` must be trusted generated markup. Escape source text before inserting it.
- `mode: 'inline'` is for `span`, `a`, `sup`, and similar paragraph content.
- `mode: 'block'` is for `div`, `table`, `aside`, and other standalone structures.

### `replaceLatexCommandCalls(text, rule)`

Use this helper to find commands and read balanced arguments without writing a command-specific brace regex.

```ts
replaceLatexCommandCalls(text, {
    name: string | readonly string[];
    requiredArgs: number;
    optionalArgs?: number;
    allowStar?: boolean;
    render(call: LatexCommandCall): string;
}): string
```

SnapTeX invokes `render(call)` for each valid command. For this input:

```latex
\badge[compact]{A {nested} value}
```

with `optionalArgs: 1` and `requiredArgs: 1`, the callback receives the equivalent of:

```ts
{
    name: 'badge',
    star: false,
    optionalArgs: [{ content: 'compact', /* source offsets */ }],
    requiredArgs: [{ content: 'A {nested} value', /* source offsets */ }],
    start: 0,
    end: 33
}
```

Each argument group contains:

| Field | Meaning |
| --- | --- |
| `content` | Text inside the delimiters. |
| `start` | Offset of `[` or `{` in the block string. |
| `end` | Offset immediately after `]` or `}`. |
| `open` / `close` | Delimiter characters. |

Unmatched or malformed calls remain unchanged in the returned text.

### Lower-level source readers

Most command rules need only `replaceLatexCommandCalls`. These lower-level readers are available when replacement is not the desired operation:

| Function | Use |
| --- | --- |
| `readLatexGroup(text, startIndex, options?)` | Read one balanced `{...}` or `[...]` group at a known position. |
| `readLatexCommandAt(text, startIndex, options)` | Read one named command at a known position. |
| `skipLatexWhitespace(text, index)` | Advance over whitespace and TeX line comments before a structural read. |

They return `undefined` when the requested structure is absent or unbalanced.

## Safe output helpers

### `escapeHtml(text)`

```ts
escapeHtml(text: string): string
```

Escapes `&`, `<`, `>`, double quotes, and single quotes. Use it when a LaTeX argument should be displayed as plain text inside generated HTML.

```ts
const contentHtml = escapeHtml(call.requiredArgs[0].content);
```

### `renderMath(tex, displayMode, renderer)`

```ts
renderMath(
    tex: string,
    displayMode: boolean,
    renderer: RenderContext
): string
```

Renders one TeX math body with KaTeX and the current document macros. The returned value is already protected HTML.

- `tex` is the math source without `$`, `\(`, or display delimiters;
- `displayMode: false` renders inline math;
- `displayMode: true` renders display math;
- `renderer` is the `RenderContext` supplied to the legacy rule.

### Inline LaTeX and math

```ts
renderInlineLatexHtml(
    text: string,
    renderMathHtml: (mathSource: string) => string
): string
```

This helper handles common inline text styles, line breaks, removed footnotes, nonbreaking spaces, and `$...$` math inside a source fragment.

Its second argument is a callback because the helper does not own a renderer. Whenever it finds `$...$`, it removes the delimiters and calls the callback with the math body.

The following expanded form makes every value explicit:

```ts
const argumentSource = call.requiredArgs[0].content;

const renderInlineMath = (mathSource: string): string => {
    return renderMath(mathSource, false, renderer);
};

const contentHtml = renderInlineLatexHtml(
    argumentSource,
    renderInlineMath
);
```

Given:

```latex
robust for $p > n$
```

the sequence is:

```text
renderInlineLatexHtml sees $p > n$
  -> calls renderInlineMath("p > n")
  -> renderInlineMath calls renderMath("p > n", false, renderer)
  -> the protected KaTeX HTML replaces $p > n$ in the returned HTML
```

The shorter arrow-function form is equivalent:

```ts
renderInlineLatexHtml(
    argumentSource,
    mathSource => renderMath(mathSource, false, renderer)
);
```

The name `mathSource` is local and arbitrary. SnapTeX supplies its value when invoking the callback.

## AST rendering API

### `AstRenderRule`

```ts
interface AstRenderRule {
    name: string;
    match(input: AstRenderInput): boolean;
    render(
        input: AstRenderInput,
        context: AstRenderContext
    ): AstRenderResult | undefined;
}
```

For each AST node, SnapTeX checks rules in registry order. `match` should cheaply reject unrelated nodes. A `render` result claims the node; `undefined` lets later rules try it.

### `AstRenderInput`

SnapTeX creates this value for the current node:

| Member | Meaning |
| --- | --- |
| `node` | Current AST node. |
| `siblings` | Nodes in the same parent container. |
| `index` | Current node's index in `siblings`. |
| `renderChildren(nodes)` | Render already-parsed child nodes with the active AST rules. |
| `renderSource(source)` | Parse and render a generated source fragment with the active AST rules. |

Prefer `renderChildren` when an argument exposes its child nodes. Use `renderSource` when another helper provides only a source string, such as an expanded user macro.

### `readAstCommandArguments(input, requiredArgCount?)`

```ts
readAstCommandArguments(
    input: AstRenderInput,
    requiredArgCount = 1
): {
    requiredArgs: string[];
    optionalArgs: string[];
    consumedNodes: number;
}
```

Reads arguments attached to the macro node and detached group siblings that belong to the same command.

- `requiredArgs` and `optionalArgs` contain source text without delimiters;
- `consumedNodes` is how many sibling nodes the walker must skip after rendering;
- `requiredArgCount` tells the detached-argument reader how many required groups belong to the command.

When returning HTML from a rule that uses this reader, return its `consumedNodes` too:

```ts
const args = readAstCommandArguments(input, 1);
return {
    html: context.escapeHtml(args.requiredArgs[0] ?? ''),
    consumedNodes: args.consumedNodes
};
```

### `AstRenderContext`

SnapTeX creates this object and supplies it as the second `render` argument.

| Member | Meaning |
| --- | --- |
| `currentMacros` | Current math macro definitions. |
| `metadata` | Current preamble metadata. |
| `bibEntries` | Parsed bibliography entries. |
| `escapeHtml(text)` | Escape plain source text for generated HTML. |
| `sourceSlice(node)` | Recover the exact source represented by one node. |
| `sourceContent(nodes)` | Recover the source spanning a node sequence. |
| `renderMath(tex, displayMode)` | Render math with current macros. |
| `renderLabel(label)` | Create the hidden anchor used by references and sync. |
| `renderRef(labels, type)` | Render `ref` or `eqref` links. |
| `resolveCitation(key)` | Resolve a stable citation number. |
| `renderCitation(command, keys, options)` | Render one citation command. |
| `getCitedKeys()` | Read cited keys collected for the document. |
| `renderImage(path, options?)` | Render an image through the host resource path. |

Unlike the legacy pipeline, AST output is already HTML. It does not use `protectHtml` or pass through Markdown.

## Metadata, dependencies, and splitting

The remaining registry interfaces control other pipeline stages rather than HTML rendering:

- `MetadataExtractor` and `readMetadataCommand` are documented in [Metadata and dependencies](./metadata);
- `BlockDependencyRule` is documented in [Metadata and dependencies](./metadata#dependency-rule);
- splitter rule kinds and emergency limits are introduced in [Extending rendering rules](./rules#choosing-the-correct-extension-point).

## Where the APIs are defined

Use paths relative to the file containing the custom rule. Do not import `src/rules.ts` from itself.

| API | Definition |
| --- | --- |
| `PreprocessRule`, `RenderContext`, registry and dependency types | `src/types.ts` |
| `escapeHtml`, `replaceLatexCommandCalls`, source group readers | `src/utils.ts` |
| `renderInlineLatexHtml`, `renderMath` | `src/rule-helpers.ts` |
| `defineRuleRegistry`, `defineAstRenderRule`, `defineBlockDependencyRule` | `src/rules.ts` |
| `AstRenderRule`, `AstRenderInput`, `AstRenderContext`, `readAstCommandArguments` | `src/ast/rules/index.ts` |
| AST node guards and readers such as `isMacroNode` and `readRequiredMacroArgument` | `src/ast/visit-utils.ts` |

Rules written directly in `src/rules.ts` use functions already declared or imported in that file. A rule moved to another module imports only the APIs it actually uses from the definition paths above.
