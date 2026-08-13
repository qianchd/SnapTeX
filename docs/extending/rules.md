# Rendering Rules Tutorial

This tutorial adds a `\badge{...}` command to one selected rendering backend. Every declaration and registry change shown below belongs in `src/rules.ts`; no other source or stylesheet file is required.

For the extension boundaries and registry fields, read [Extension Model](./index.md). For exact function contracts, use the [Rule API Reference](./rule-api.md).

::: warning Source-level API
SnapTeX does not load executable rules from a TeX project. Rebuild SnapTeX and fully reload the preview after changing `src/rules.ts`.
:::

## Expected result

Input:

```latex
The estimate is \badge{locally robust} under the stated conditions.
```

Desired HTML shape:

```html
The estimate is <span style="...">locally robust</span> under the stated conditions.
```

The fixed inline style keeps this example completely inside `src/rules.ts`. A built-in feature with shared styling may use a class in `media/preview-style.css`, but that is not required for a self-contained extension.

Add the presentation constant near the other rule declarations in `src/rules.ts`:

```ts
const BADGE_STYLE = [
    'display:inline-block',
    'padding:0.08em 0.42em',
    'border:1px solid currentColor',
    'border-radius:3px',
    'font-size:0.9em'
].join(';');
```

The legacy and AST examples below use this same constant, but the rules themselves are independent.

## Choose the backend

Rendering has two independent rule arrays:

| Backend to extend | Registry field | Matching model |
| --- | --- | --- |
| `legacy` | `renderRules` | Ordered source transformations followed by Markdown |
| `ast(experimental)` | `astRenderRules` | Parsed nodes claimed by the first matching AST rule |

Implement the path you intend to use. A legacy rule does not require an AST rule, and an AST rule does not require a legacy rule.

## Legacy implementation

### 1. Add one rule in `src/rules.ts`

`PreprocessRule`, `replaceLatexCommandCalls`, and `escapeHtml` are already used by the file. Add this declaration near the other rule definitions:

```ts
const BADGE_RENDER_RULE: PreprocessRule = {
    name: 'badge',
    priority: 200,
    apply: (text, renderer) => replaceLatexCommandCalls(text, {
        name: 'badge',
        requiredArgs: 1,
        render: call => renderer.protectHtml(
            'badge',
            `<span style="${BADGE_STYLE}">${escapeHtml(call.requiredArgs[0].content)}</span>`,
            'inline'
        )
    })
};
```

Read the callback from outside to inside:

1. SnapTeX calls `apply(text, renderer)` with the current block and a `RenderContext`.
2. `replaceLatexCommandCalls` scans `text` for a valid `\badge` command with one balanced required argument.
3. For each match, it calls `render(call)`.
4. `call.requiredArgs[0].content` is the text inside the braces.
5. `escapeHtml` prevents source text from becoming active HTML.
6. `protectHtml` hides the generated `span` behind a token until Markdown rendering is complete.

The priority is after SnapTeX's built-in math and text-style rules. If the argument contains content already converted to a protected token, nesting it inside the badge is safe: the protection manager restores nested tokens after Markdown.

### 2. Register it

Change only the `renderRules` field of `SNAP_TEX_RULES`:

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

`defineRuleRegistry` sorts legacy rules by ascending `priority`, so the declaration's position in this array does not change its execution order.

### 3. Why each API is necessary

| API | Why this rule uses it |
| --- | --- |
| `PreprocessRule` | Defines the legacy rule contract. |
| `replaceLatexCommandCalls` | Reads balanced optional/required arguments and preserves malformed source. |
| `escapeHtml` | Makes user-controlled plain text safe inside HTML. |
| `renderer.protectHtml` | Prevents Markdown from escaping or restructuring generated HTML. |

There is no command-specific brace regex, separate postprocessor, renderer switch, or webview modification.

## AST implementation

This section is an alternative implementation for `ast(experimental)`. It does not depend on the legacy rule above.

### 1. Add one AST rule in `src/rules.ts`

Add a value import for the argument reader at the top of `src/rules.ts` (the existing re-export alone does not create a local binding):

```ts
import { readAstCommandArguments } from './ast/rules';
```

Then add the rule declaration:

```ts
const AST_BADGE_RENDER_RULE = defineAstRenderRule({
    name: 'ast-badge',
    match: input =>
        input.node.type === 'macro' && input.node.content === 'badge',
    render: (input, context) => {
        const args = readAstCommandArguments(input, 1);
        const content = args.requiredArgs[0];
        if (content === undefined) {
            return undefined;
        }

        return {
            html: `<span style="${BADGE_STYLE}">${context.escapeHtml(content)}</span>`,
            consumedNodes: args.consumedNodes
        };
    }
});
```

The callback flow is different from legacy:

1. The AST walker creates `AstRenderInput` for the current parsed node.
2. `match(input)` cheaply checks whether the node is the `badge` macro.
3. `readAstCommandArguments(input, 1)` reads one required argument, including a detached sibling group when the parser did not attach an unknown command's argument.
4. `context.escapeHtml(content)` safely renders this plain-text version.
5. `consumedNodes` tells the walker to skip sibling nodes consumed as arguments.

AST output is already HTML. It does not pass through Markdown, so AST rules do not call `protectHtml`.

### 2. Register it

Change only `astRenderRules`:

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

AST precedence is array order. Put a narrow custom command rule before broader defaults that could claim the same macro.

## Plain text versus nested LaTeX

Both examples above promise plain argument text and therefore escape it. Decide this contract before writing a rule:

| Promised argument | Recommended rendering |
| --- | --- |
| Plain text only | `escapeHtml(...)` / `context.escapeHtml(...)` |
| Common raw inline LaTeX in a specialized legacy renderer | `renderInlineLatexHtml(...)` with an explicit math callback |
| Already parsed AST children | `input.renderChildren(...)` |
| Generated LaTeX source in AST mode | `input.renderSource(...)` |

Do not add a more powerful renderer unless the command actually promises nested syntax. The [Rule API Reference](./rule-api.md#renderinlinelatexhtmltext-rendermathhtml) explains every argument of `renderInlineLatexHtml`, including where its callback parameter comes from.

## Legacy ordering

Legacy rules form one transformation pipeline:

```text
raw block source
  -> comments and layout cleanup
  -> math, labels, references, citations
  -> floats and theorem structures
  -> headings and lists
  -> text styles
  -> custom rule at priority 200
  -> Markdown
  -> restore protected HTML
```

Choose priority relative to the existing `DEFAULT_RENDER_RULES` declarations in `src/rules.ts`:

- run early to inspect raw LaTeX;
- run after math/references when nested generated tokens should be preserved;
- run before a broader rule that would otherwise consume the same syntax.

Avoid equal priorities when order matters.

## AST ownership

For each AST node:

1. rules are checked in array order;
2. `match` rejects unrelated nodes;
3. the first `render` returning a result owns the node;
4. `undefined` lets later rules try it;
5. fallback rendering handles an unclaimed node.

A narrow command or environment rule therefore belongs before a general macro/environment rule.

## When a dependency rule is needed

The badge output depends only on its block source. Changing that source changes the block hash, so no dependency rule is necessary.

Add a dependency only when unchanged source can render differently because document-level state changed. For example, a `\makecover` block can depend on title metadata:

```ts
const MAKE_COVER_DEPENDENCY = defineBlockDependencyRule({
    name: 'make-cover',
    collect: ({ text, deps }) => text.includes('\\makecover')
        ? [deps.metadata('title')]
        : []
});
```

Register that declaration in `blockDependencyRules`. See [Metadata and Dependencies](./metadata.md) for the complete lifecycle.

## Test the rendered behavior

Use `PreviewUpdateService` with the registry and selected backend. Assert final output rather than implementation strings:

```ts
const service = new PreviewUpdateService(new MemoryFileProvider(), SNAP_TEX_RULES);
const payload = await service.render(uri, [
    '\\begin{document}',
    'The estimate is \\badge{locally robust}.',
    '\\end{document}'
].join('\n'), {
    backendMode: 'legacy',
    deferFullHtml: false
});

const html = payload.htmls?.join('') ?? '';
assert.match(html, /locally robust/);
assert.match(html, /border:1px solid currentColor/);
assert.doesNotMatch(html, /\\badge/);
```

For the AST version, change `backendMode` to `ast(experimental)`. Test only the backend whose rule you added; there is no requirement to create a counterpart solely for test symmetry.

## What not to add

Do not solve a command extension by adding another:

- balanced-brace parser;
- HTML token store;
- Markdown pass;
- AST parse inside each rule;
- document-wide dirty-block mechanism;
- host message or file-access path.

Those are shared services. Keeping the extension inside `src/rules.ts` makes ownership visible and prevents one feature from creating a parallel pipeline.
