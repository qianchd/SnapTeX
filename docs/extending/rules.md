# Rendering Rules Tutorial

This tutorial adds a `\badge{...}` command by editing only `src/rules.ts`. It shows two independent implementations because SnapTeX has two rendering backends. Follow the section for the backend you want to extend; you do not need to implement both.

For the extension boundaries and registry fields, read [Extension Model](./index.md). For exact function contracts, use the [Rule API Reference](./rule-api.md).

All snippets are repository TypeScript, not code placed in a `.tex` project. [Source API Scope](./api/scope.md) explains imports, callback ownership, output safety, and testing.

::: warning Source-level API
SnapTeX does not load executable rules from a TeX project. Rebuild SnapTeX and fully reload the preview after changing `src/rules.ts`.
:::

## What you will change

There are only two required actions:

1. declare one rule object in `src/rules.ts`;
2. add that object to `renderRules` or `astRenderRules` in `SNAP_TEX_RULES`.

The declaration explains behavior. The registry makes that behavior active. A rule constant that is never added to the registry never runs.

```text
one block or AST node
  -> registered rule callback
  -> shared argument reader
  -> safe generated output
  -> existing preview pipeline
```

You do not modify `SmartRenderer`, `LatexDocument`, the webview, or host adapters for this command.

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

Implement the path selected in the preview setting. A legacy rule does not require an AST rule, and an AST rule does not require a legacy rule.

## Legacy implementation

Use this path when extending the `legacy` backend. A legacy rule receives one block as source text, transforms it, and returns text for the next rule. Markdown runs after every registered legacy rule has finished.

### 1. Reuse the existing imports

`src/rules.ts` already imports these APIs. If an import is absent in a future version, extend the existing import from the same module instead of adding a second import statement:

```ts
import { PreprocessRule } from './types';
import { escapeHtml, replaceLatexCommandCalls } from './utils';
```

`PreprocessRule` is a TypeScript contract. The other two are runtime helpers called by the rule.

### 2. Declare the rule

Add this declaration near the other legacy rule definitions:

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

The values have different owners:

| Value | Created by | Meaning |
| --- | --- | --- |
| `text` | `SmartRenderer` | Current block after lower-priority rules |
| `renderer` | `SmartRenderer` | Current document state and legacy output services |
| `call` | `replaceLatexCommandCalls` | One validated `\badge{...}` call |
| `call.requiredArgs[0].content` | Balanced command reader | Source inside the first `{...}` group |

The inner `render: call => ...` callback belongs to `replaceLatexCommandCalls`; it is not a second SnapTeX rule.

The priority is after SnapTeX's built-in math and text-style rules. If the argument contains content already converted to a protected token, nesting it inside the badge is safe: the protection manager restores nested tokens after Markdown.

### 3. Register it

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

At runtime the complete path is:

```text
SNAP_TEX_RULES.renderRules
  -> SmartRenderer sorts/runs apply callbacks
  -> BADGE_RENDER_RULE reads \badge arguments
  -> protectHtml returns a temporary token
  -> Markdown renders surrounding text
  -> SnapTeX restores the generated span
```

### 4. Why each API is necessary

| API | Why this rule uses it |
| --- | --- |
| `PreprocessRule` | Defines the legacy rule contract. |
| `replaceLatexCommandCalls` | Reads balanced optional/required arguments and preserves malformed source. |
| `escapeHtml` | Makes user-controlled plain text safe inside HTML. |
| `renderer.protectHtml` | Prevents Markdown from escaping or restructuring generated HTML. |

There is no command-specific brace regex, separate postprocessor, renderer switch, or webview modification.

### 5. Preserve unsupported input

`replaceLatexCommandCalls` leaves malformed calls such as `\badge{unclosed` unchanged. Your rule therefore handles valid calls and preserves source it cannot safely understand. Avoid a direct brace regex, which would lose this behavior for nested or commented arguments.

## AST implementation

This section is an alternative implementation for `ast(experimental)`. It does not depend on the legacy rule above.

### 1. Import the AST argument reader

Replace the existing direct re-export with a local import plus re-export. A re-export alone does not create a binding that code in `src/rules.ts` can call:

```ts
import { readAstCommandArguments } from './ast/rules';
export { readAstCommandArguments };
```

`defineAstRenderRule` is declared in `src/rules.ts`, so it needs no import there. Add the rule declaration:

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

The values have different owners:

| Value | Created by | Meaning |
| --- | --- | --- |
| `input` | AST walker | Current node, siblings, index, and recursive render methods |
| `context` | AST renderer | Current document state and safe HTML services |
| `args` | `readAstCommandArguments` | Parsed optional/required command arguments |
| `content` | The argument reader | Plain source text for the first required argument |

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

At runtime the complete path is:

```text
SNAP_TEX_RULES.astRenderRules
  -> AST walker checks match callbacks in array order
  -> AST_BADGE_RENDER_RULE reads command arguments
  -> render returns final escaped HTML
  -> walker advances by consumedNodes
```

## Plain text versus nested LaTeX

Both examples above promise plain argument text and therefore escape it. Decide this contract before writing a rule:

| Promised argument | Recommended rendering |
| --- | --- |
| Plain text only | `escapeHtml(...)` / `context.escapeHtml(...)` |
| Common raw inline LaTeX in a specialized legacy renderer | `renderInlineLatexHtml(...)` with an explicit math callback |
| Already parsed AST children | `input.renderChildren(...)` |
| Generated LaTeX source in AST mode | `input.renderSource(...)` |

Do not add a more powerful renderer unless the command actually promises nested syntax. The [`renderInlineLatexHtml` reference](./api/rendering/render-inline-latex-html) explains every argument, including where its callback parameter comes from.

For the badge example, plain text is an intentional contract. If `\badge{\textbf{important}}` must preserve nested formatting, the AST implementation should render parsed children rather than flattening them, while a specialized legacy implementation may use `renderInlineLatexHtml`. Start with the narrowest input contract the command actually needs.

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

The dependency rule is separate because it answers a separate question. `BADGE_RENDER_RULE` explains how to render source that changed. `MAKE_COVER_DEPENDENCY` explains why an unchanged `\makecover` block must rerender after title metadata changes.

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

## Debugging checklist

| Symptom | Check |
| --- | --- |
| Rule never runs | The rule object appears in the correct `SNAP_TEX_RULES` array and the preview uses that backend |
| Legacy HTML is printed as text | Generated HTML was not passed through `renderer.protectHtml` |
| AST rule never owns the node | A preceding rule claims it, or `match` checks the wrong bare macro/environment name |
| Text disappears after a command | Required argument count or `consumedNodes` is wrong |
| Nested braces break parsing | A command-specific regex replaced the shared balanced reader |
| Metadata changes but HTML stays stale | The unchanged block needs a `blockDependencyRules` descriptor |

## What not to add

Do not solve a command extension by adding another:

- balanced-brace parser;
- HTML token store;
- Markdown pass;
- AST parse inside each rule;
- document-wide dirty-block mechanism;
- host message or file-access path.

Those are shared services. Keeping the extension inside `src/rules.ts` makes ownership visible and prevents one feature from creating a parallel pipeline.
