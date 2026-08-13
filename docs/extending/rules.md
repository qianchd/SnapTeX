# Extending rendering rules

SnapTeX's extension point is the `SNAP_TEX_RULES` object in `src/rules.ts`. It is a registry: each property is a list of rules used by one stage of document processing.

::: warning Source-level extension API
Rules are currently customized in the SnapTeX source tree. They are not loaded from a user's TeX project or from VS Code settings. After changing `src/rules.ts`, rebuild SnapTeX and fully reload the preview.
:::

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

The two arrays are separate because the backends render differently:

| Selected backend | Rules used for block rendering |
| --- | --- |
| `legacy` | `renderRules` only |
| `ast(experimental)` | `astRenderRules` only |

There is no automatic fallback from an AST rule to the legacy rule with the same feature. To make a new command work in both modes, register one rule in each array. Shared HTML helpers can keep the output and styling consistent.

## Complete example: `\badge{...}`

Suppose this input should render as a styled inline badge:

```latex
The result is \badge{locally robust} under the stated conditions.
```

The implementation has three small parts:

1. one shared HTML wrapper;
2. one legacy rule;
3. one AST rule.

### 1. Shared output

Add a helper near the rule definitions in `src/rules.ts`:

```ts
function renderBadgeHtml(contentHtml: string): string {
    return `<span class="latex-badge">${contentHtml}</span>`;
}
```

The helper accepts already-rendered HTML. Parsing remains the responsibility of each backend.

### 2. Legacy render rule

The legacy renderer runs the block text through every `PreprocessRule` in ascending `priority` order. Each rule receives the current text and returns the text for the next rule.

```ts
const BADGE_RENDER_RULE: PreprocessRule = {
    name: 'badge',
    priority: 175,
    apply: (text, renderer) => replaceLatexCommandCalls(text, {
        name: 'badge',
        requiredArgs: 1,
        render: call => {
            const contentHtml = renderInlineLatexHtml(
                call.requiredArgs[0].content,
                tex => renderMath(tex, false, renderer)
            );
            return renderer.protectHtml(
                'badge',
                renderBadgeHtml(contentHtml),
                'inline'
            );
        }
    })
};
```

The important pieces are:

| Field or call | Meaning |
| --- | --- |
| `name` | Diagnostic name for the rule. It does not match LaTeX by itself. |
| `priority` | Execution order. Lower values run first. `defineRuleRegistry()` sorts the array. |
| `apply(text, renderer)` | Transforms the whole current block and returns it for the next rule. |
| `replaceLatexCommandCalls(...)` | Reads balanced LaTeX arguments; prefer it to a new command-specific brace regex. |
| `renderInlineLatexHtml(...)` | Renders common inline LaTeX and math inside the argument. |
| `protectHtml(...)` | Hides trusted generated HTML from Markdown until Markdown rendering finishes. |

Use protection mode `'inline'` for elements such as `span`, `a`, and `sup` that remain inside a paragraph. Use `'block'` for standalone structures such as `div`, `table`, and `aside`. The first argument, `'badge'`, is only a token namespace; it does not select CSS or invoke another rule.

Never interpolate unescaped source text directly into HTML. Use an existing renderer/helper, or `escapeHtml()` for plain text.

### 3. AST render rule

The AST renderer walks parsed nodes. For each node it checks `astRenderRules` in array order and uses the first rule that returns a result.

```ts
const AST_BADGE_RENDER_RULE = defineAstRenderRule({
    name: 'ast-badge',
    match: input =>
        input.node.type === 'macro' && input.node.content === 'badge',
    render: input => {
        const args = readAstCommandArguments(input);
        const content = args.requiredArgs[0];
        if (content === undefined) {
            return undefined;
        }

        return {
            html: renderBadgeHtml(input.renderSource(content)),
            consumedNodes: args.consumedNodes
        };
    }
});
```

Here the contract is different:

| Field or call | Meaning |
| --- | --- |
| `match(input)` | Cheap ownership check for the current AST node. |
| `render(input, context)` | Returns rendered HTML, or `undefined` to let later AST rules try the node. |
| `readAstCommandArguments(input)` | Reads attached and detached optional/required arguments consistently. |
| `input.renderChildren(nodes)` | Renders child AST nodes without reparsing them. Use it when you already have child nodes. |
| `input.renderSource(source)` | Parses and renders a source fragment through the same AST rules. It is useful when a helper returned argument text. |
| `consumedNodes` | Tells the walker how many sibling nodes belong to this command. Always preserve the value returned by the argument reader. |

AST rules have no numeric priority. Their array order is their precedence. Put a specific custom rule before the default catch-all macro rules.

Do not call the AST parser inside a render rule. Use `renderChildren()` or `renderSource()` so nesting, safety limits, and the active registry remain consistent.

### 4. Register both rules

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
    astRenderRules: [
        AST_BADGE_RENDER_RULE,
        ...DEFAULT_AST_RENDER_RULES
    ],
    blockDependencyRules: DEFAULT_BLOCK_DEPENDENCY_RULES,
    splitterConfig: DEFAULT_SPLITTER_CONFIG,
    splitterRules: DEFAULT_SPLITTER_RULES
});
```

`BADGE_RENDER_RULE` may appear anywhere in `renderRules` because the registry sorts legacy rules by `priority`. `AST_BADGE_RENDER_RULE` must appear before the generic default AST macro rules because AST rules retain array order.

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

At this point `\badge{...}` is supported by both backend modes.

## Choosing the correct extension point

Not every extension is a render rule. Start with the user-visible behavior:

| Goal | Registry field |
| --- | --- |
| Render a command or environment in legacy mode | `renderRules` |
| Render a command or environment in AST mode | `astRenderRules` |
| Support the same syntax in both modes | Add one rule to each of the two arrays |
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

Test the rendered result through `PreviewUpdateService`, which exercises document parsing, the selected backend, the registry, rendering, and update payloads together.

For a feature intended for both modes, run the same behavior assertion twice:

```ts
for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
    const payload = await service.render(uri, source, {
        backendMode,
        deferFullHtml: false
    });
    const html = payload.htmls?.join('') ?? '';
    assert.match(html, /class="latex-badge"/);
    assert.match(html, /locally robust/);
}
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
