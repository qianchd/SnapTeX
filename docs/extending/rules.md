# Extending rendering rules

SnapTeX's extension point is the `SNAP_TEX_RULES` object in `src/rules.ts`. It is a registry: each property is a list of rules used by one stage of document processing.

::: warning Source-level extension API
Rules are currently customized in the SnapTeX source tree. They are not loaded from a user's TeX project or from VS Code settings. After changing `src/rules.ts`, rebuild SnapTeX and fully reload the preview.
:::

This page is a task-oriented tutorial. Exact signatures and the origin of every callback argument used below are documented in the [Rule API reference](./rule-api).

## How the registry is connected

`PreviewUpdateService` passes the same registry to `LatexDocument` and `SmartRenderer`. The selected backend then reads one of the two rendering-rule arrays:

```text
SNAP_TEX_RULES
|
+-- renderRules ----------> legacy block renderer
|                           source -> rules by priority -> Markdown -> HTML
|
+-- astRenderRules -------> AST block renderer
|                           source -> AST -> first matching rule -> HTML
|
+-- metadataExtractors ---> document metadata
+-- blockDependencyRules -> refresh unchanged dependent blocks
+-- splitterConfig -------> block-size limits
+-- splitterRules --------> block-boundary behavior
```

This is the direct relationship between the registry and `PreprocessRule`:

```ts
interface RuleRegistry {
    renderRules: readonly PreprocessRule[];
    astRenderRules: readonly AstRenderRule[];
    // Other pipeline stages omitted here.
}
```

A `PreprocessRule` is simply one element placed in `SNAP_TEX_RULES.renderRules`. An `AstRenderRule` is one element placed in `SNAP_TEX_RULES.astRenderRules`.

The two arrays are separate because the backends render differently. Choose the array for the backend you are extending:

| Selected backend | Rules used for block rendering |
| --- | --- |
| `legacy` | `renderRules` only |
| `ast(experimental)` | `astRenderRules` only |

A custom rule belongs to one of these paths. Extending legacy does not require an AST rule, and extending AST does not require a legacy rule.

## Legacy example: `\badge{...}`

Suppose this input should render as a styled inline badge:

```latex
The result is \badge{locally robust} under the stated conditions.
```

This example targets the `legacy` backend. The implementation has three small parts:

1. one HTML wrapper;
2. one legacy rule;
3. registration in `renderRules`.

### 1. Shared output

Add a helper near the rule definitions in `src/rules.ts`:

```ts
function renderBadgeHtml(contentHtml: string): string {
    return `<span class="latex-badge">${contentHtml}</span>`;
}
```

The helper accepts safe HTML. The first version of the example treats the badge argument as plain text; an optional later section adds nested LaTeX rendering.

### 2. Legacy render rule

The legacy renderer runs the block text through every `PreprocessRule` in ascending `priority` order. Each rule receives the current text and returns the text for the next rule.

```ts
const BADGE_RENDER_RULE: PreprocessRule = {
    name: 'badge',
    priority: 175,
    apply: (text, renderer) => replaceLatexCommandCalls(text, {
        name: 'badge',
        requiredArgs: 1,
        render: call => renderer.protectHtml(
            'badge',
            renderBadgeHtml(escapeHtml(call.requiredArgs[0].content)),
            'inline'
        )
    })
};
```

Read the code from the inside out:

1. `replaceLatexCommandCalls` finds `\badge{...}` and reads one balanced required argument.
2. `call.requiredArgs[0].content` is the source text between `{` and `}`.
3. `escapeHtml` makes that source safe to place inside HTML.
4. `renderBadgeHtml` adds the badge element.
5. `protectHtml` prevents Markdown from escaping that generated element later.

The important pieces are:

| Field or call | Meaning |
| --- | --- |
| `name` | Diagnostic name for the rule. It does not match LaTeX by itself. |
| `priority` | Execution order. Lower values run first. `defineRuleRegistry()` sorts the array. |
| `apply(text, renderer)` | Transforms the whole current block and returns it for the next rule. |
| `replaceLatexCommandCalls(...)` | Reads balanced LaTeX arguments; prefer it to a new command-specific brace regex. |
| `protectHtml(...)` | Hides trusted generated HTML from Markdown until Markdown rendering finishes. |

Use protection mode `'inline'` for elements such as `span`, `a`, and `sup` that remain inside a paragraph. Use `'block'` for standalone structures such as `div`, `table`, and `aside`. The first argument, `'badge'`, is only a token namespace; it does not select CSS or invoke another rule.

Never interpolate unescaped source text directly into HTML. Use an existing renderer/helper, or `escapeHtml()` for plain text.

### 3. Register the legacy rule

Finally, connect the definitions to the actual registry:

```ts
export const SNAP_TEX_RULES = defineRuleRegistry({
    metadataExtractors: [
        BUILTIN_METADATA_EXTRACTOR,
        EDITOR_METADATA_EXTRACTOR
    ],
    renderRules: [
        ...DEFAULT_RENDER_RULES,
        BADGE_RENDER_RULE
    ],
    astRenderRules: DEFAULT_AST_RENDER_RULES,
    blockDependencyRules: DEFAULT_BLOCK_DEPENDENCY_RULES,
    splitterConfig: DEFAULT_SPLITTER_CONFIG,
    splitterRules: DEFAULT_SPLITTER_RULES
});
```

`BADGE_RENDER_RULE` may appear anywhere in `renderRules` because the registry sorts legacy rules by `priority`. The AST registry remains unchanged because this extension targets legacy rendering.

Add the visual styling to the shared preview stylesheet, `media/preview-style.css`:

```css
.latex-badge {
    display: inline-block;
    padding: 0.08em 0.42em;
    border: 1px solid currentColor;
    border-radius: 3px;
    font-size: 0.9em;
}
```

At this point `\badge{...}` is available when the `legacy` backend is selected.

## Legacy option: render LaTeX inside the argument

The minimal rules above deliberately render the argument as plain text. If the promised syntax includes content such as this:

```latex
\badge{robust for $p > n$}
```

replace the legacy rule's `escapeHtml(...)` call with:

```ts
const argumentSource = call.requiredArgs[0].content;
const renderInlineMath = (mathSource: string) =>
    renderMath(mathSource, false, renderer);
const contentHtml = renderInlineLatexHtml(
    argumentSource,
    renderInlineMath
);
```

The two arguments are:

1. `argumentSource`: the raw contents of `\badge{...}`;
2. `renderInlineMath`: a callback used whenever the helper finds `$...$`.

`mathSource` is not a global variable. It is the callback parameter supplied by `renderInlineLatexHtml`. For `$p > n$`, the helper invokes `renderInlineMath('p > n')`. The call to `renderMath(..., false, renderer)` then asks KaTeX for inline, rather than display, math.

## AST example: `\badge{...}`

This is an independent alternative for developers extending `ast(experimental)`. It does not require the legacy rule above.

The AST renderer walks parsed nodes. For each node it checks `astRenderRules` in array order and uses the first rule that returns a result:

```ts
const AST_BADGE_RENDER_RULE = defineAstRenderRule({
    name: 'ast-badge',
    match: input =>
        input.node.type === 'macro' && input.node.content === 'badge',
    render: (input, context) => {
        const args = readAstCommandArguments(input);
        const content = args.requiredArgs[0];
        if (content === undefined) {
            return undefined;
        }

        return {
            html: `<span class="latex-badge">${context.escapeHtml(content)}</span>`,
            consumedNodes: args.consumedNodes
        };
    }
});
```

The important pieces are:

| Field or call | Meaning |
| --- | --- |
| `match(input)` | Cheap ownership check for the current AST node. |
| `render(input, context)` | Returns rendered HTML, or `undefined` to let later AST rules try the node. |
| `readAstCommandArguments(input)` | Reads attached and detached optional/required arguments consistently. |
| `context.escapeHtml(content)` | Escapes plain argument text before it enters HTML. |
| `consumedNodes` | Tells the walker how many sibling nodes belong to this command. Preserve the value returned by the argument reader. |

Register only this AST rule while leaving the legacy registry unchanged:

```ts
export const SNAP_TEX_RULES = defineRuleRegistry({
    metadataExtractors: [
        BUILTIN_METADATA_EXTRACTOR,
        EDITOR_METADATA_EXTRACTOR
    ],
    renderRules: DEFAULT_RENDER_RULES,
    astRenderRules: [
        AST_BADGE_RENDER_RULE,
        ...DEFAULT_AST_RENDER_RULES
    ],
    blockDependencyRules: DEFAULT_BLOCK_DEPENDENCY_RULES,
    splitterConfig: DEFAULT_SPLITTER_CONFIG,
    splitterRules: DEFAULT_SPLITTER_RULES
});
```

AST rules have no numeric priority. Their array order is their precedence, so this command-specific rule appears before the generic default macro rules.

If the badge argument may contain nested LaTeX, use parsed children rather than flattening the argument to text:

```ts
const argument = readRequiredMacroArgument(input.node);
if (!argument) {
    return undefined;
}
return {
    html: renderBadgeHtml(input.renderChildren(argument.content))
};
```

This enhanced version requires importing `readRequiredMacroArgument` from `src/ast/visit-utils.ts`. See [`AstRenderInput`](./rule-api#astrenderinput) for the AST child-rendering contract.

## Choosing the correct extension point

Not every extension is a render rule. Start with the user-visible behavior:

| Goal | Registry field |
| --- | --- |
| Render a command or environment in legacy mode | `renderRules` |
| Render a command or environment in AST mode | `astRenderRules` |
| Read a preamble command such as `\advisor{...}` | `metadataExtractors` |
| Refresh an unchanged block when metadata or citations change | `blockDependencyRules` |
| Change where structural blocks are split | `splitterRules` |
| Change emergency block-length limits | `splitterConfig` |
| Change only appearance | `media/preview-style.css` |

Metadata and dependency rules are covered separately in [Metadata and dependencies](./metadata).

## Legacy rule ordering

Legacy rules form one transformation pipeline. Priority therefore expresses which representation a rule expects:

```text
raw LaTeX
  -> comments/layout cleanup
  -> math, labels, references, citations
  -> figures, tables, algorithms, theorem structures
  -> sections and lists
  -> text styles
  -> Markdown
  -> restore protected HTML
```

Choose a priority relative to the existing `DEFAULT_RENDER_RULES` entries in `src/rules.ts`:

- run early when the rule must inspect nearly raw LaTeX;
- run after math/reference rules when it should receive their protected tokens;
- run before a broader rule that would otherwise consume the same syntax.

Rules with the same priority retain their input array order, but relying on ties makes ownership harder to understand. Prefer a distinct priority when order matters.

## AST rule ownership and nesting

AST precedence is simpler but stricter:

1. the walker visits a node;
2. rules are checked from the first array element to the last;
3. `match()` skips unrelated nodes;
4. the first `render()` that returns a result owns the node;
5. if every rule declines, the fallback renderer emits ordinary text/children or escaped unsupported syntax.

A narrow rule should therefore be placed before a broad rule. For example, a rule matching only `\badge` belongs before a generic rule matching every macro.

Use the input according to the structure you need:

```ts
// Render parsed child nodes and preserve nested rules without reparsing.
input.renderChildren(argument.content);

// Render a source string returned by a general argument helper.
input.renderSource(argumentText);

// Read document services such as metadata, bibliography, math, and references.
context.metadata;
context.bibEntries;
context.renderMath(tex, false);
context.renderRef(['label'], 'ref');
```

## When a dependency rule is also required

Most render rules depend only on their own block text. Their source hash changes when their input changes, so the normal block diff rerenders them automatically.

A dependency rule is needed when unchanged source can produce different HTML because external state changed. For example, a `\makecover` block may depend on preamble metadata:

```ts
const MAKE_COVER_DEPENDENCY = defineBlockDependencyRule({
    name: 'make-cover',
    collect: ({ text, deps }) => text.includes('\\makecover')
        ? [deps.metadata('title'), deps.metadata('custom.editor')]
        : []
});
```

Register it in `blockDependencyRules`. SnapTeX stores the collected dependency description for that block and later compares fingerprints; it does not rerun every dependency collector for every unchanged block.

## Testing an extension

Test the rendered result through `PreviewUpdateService`, which exercises document parsing, the selected backend, the registry, rendering, and update payloads together. Set `backendMode` to the backend that owns the custom rule:

```ts
const payload = await service.render(uri, source, {
    backendMode: 'legacy',
    deferFullHtml: false
});
const html = payload.htmls?.join('') ?? '';
assert.match(html, /class="latex-badge"/);
assert.match(html, /locally robust/);
```

Also test nested content that the rule promises to support, such as inline math or text styling. Avoid tests that only inspect whether a function name or regex exists; the public behavior is the generated preview HTML.

## Infrastructure that rules should not replace

Custom rules should not implement their own versions of:

- balanced LaTeX command/group reading;
- document source storage and block spans;
- hash diffing and patch selection;
- numbering scans;
- host/webview messages;
- virtualization and resource lifetimes;
- file access;
- AST parsing inside individual rules.

Those services remain shared infrastructure so a rendering extension cannot silently break synchronization, incremental updates, or memory behavior.
