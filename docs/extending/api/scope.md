# Source API Scope

The Rule API is a source-level extension surface for contributors building SnapTeX. It is not a package that a `.tex` project imports, and it is not a runtime plugin API loaded from user files.

## Where extension code lives

Declare, import, and register custom behavior in `src/rules.ts`. The active registry is exported from that file as `SNAP_TEX_RULES`:

```ts
export const SNAP_TEX_RULES = defineRuleRegistry({
    metadataExtractors: [/* document metadata readers */],
    renderRules: [/* legacy source rules */],
    astRenderRules: [/* AST node rules */],
    blockDependencyRules: [/* external invalidation */],
    splitterConfig: DEFAULT_SPLITTER_CONFIG,
    splitterRules: [/* block boundaries */]
});
```

The registry is a lifecycle snapshot shared by `LatexDocument` and `SmartRenderer`. Changing a declaration requires rebuilding SnapTeX and fully reloading the preview.

## How to read an API page

Each page describes one of three kinds of callable value:

| Kind | How it becomes available | Example |
| --- | --- | --- |
| Imported function | Import it from the definition module into `src/rules.ts` | `replaceLatexCommandCalls`, `escapeHtml` |
| Rule callback | SnapTeX invokes a function you place on a registered rule object | `PreprocessRule.apply`, `AstRenderRule.render` |
| Context method | SnapTeX creates a context and passes it into a callback | `renderer.protectHtml`, `context.renderMath` |

When an example says `apply: (text, renderer) => ...`, SnapTeX supplies both parameters. When it says `render: (input, context) => ...`, the AST walker supplies those parameters.

A nested callback has a different owner. In this example:

```ts
renderInlineLatexHtml(source, tex => context.renderMath(tex, false))
```

your rule supplies `source` and the callback function; `renderInlineLatexHtml` later supplies `tex` each time it finds `$...$`; SnapTeX supplied `context` to the enclosing AST rule. Reading from the outer call inward makes ownership explicit.

Examples keep every positional interface parameter visible. An intentionally
unused parameter is prefixed with `_`, as in
`apply: (text, _renderer) => text`. Object inputs are different: a callback
such as `collect: ({ text, deps }) => ...` still receives the complete
`BlockDependencyInput` object and merely extracts the members it uses.

## Declaration is not registration

These two operations are intentionally separate:

```ts
const RULE = defineAstRenderRule({ /* match and render */ });

export const SNAP_TEX_RULES = defineRuleRegistry({
    // RULE starts running only after it appears here.
    astRenderRules: [RULE, ...DEFAULT_AST_RENDER_RULES],
    // ...the other required fields
});
```

`defineAstRenderRule` and `defineBlockDependencyRule` return the object passed to them. They provide contextual typing; they do not mutate the global registry. `defineRuleRegistry` creates the lifecycle snapshot consumed by the document and renderer.

## Definition and import locations

These are repository-internal module paths, relative to `src/rules.ts`:

| API area | Definition module | Typical import |
| --- | --- | --- |
| Registry functions and defaults | `src/rules.ts` | Already local |
| Shared rule types | `src/types.ts` | `./types` |
| Balanced source readers and escaping | `src/utils.ts` | `./utils` |
| Legacy/shared rendering helpers | `src/rule-helpers.ts` | `./rule-helpers` |
| AST contracts and argument readers | `src/ast/rules/index.ts` | `./ast/rules` |
| AST node readers | `src/ast/visit-utils.ts` | `./ast/visit-utils` |
| Metadata readers | `src/metadata.ts` | `./metadata` |
| End-to-end update service | `src/preview-update-service.ts` | Used from tests/hosts rather than registered |

Use a `type` import for TypeScript-only contracts and a normal import for functions used at runtime. Existing imports in `src/rules.ts` should be extended instead of creating a second alias for the same helper.

## Output contracts

Legacy and AST rules produce output differently:

| Path | Rule output | Safety requirement |
| --- | --- | --- |
| Legacy | Transformed source that later passes through Markdown | Escape source-controlled text and hide generated HTML with `renderer.protectHtml` |
| AST | Final HTML for the claimed node | Escape source-controlled text and use context methods for math, references, citations, and images |

Do not return source-controlled text inside HTML without escaping it. Do not call legacy `protectHtml` from AST rules because AST output bypasses Markdown.

## Minimal verification

Use `PreviewUpdateService` to test the same parse, scan, dependency, and rendering path used by hosts:

```ts
const service = new PreviewUpdateService(
    new MemoryFileProvider(),
    SNAP_TEX_RULES
);

const payload = await service.render(uri, source, {
    backendMode: 'legacy',
    deferFullHtml: false
});

const html = payload.htmls?.join('') ?? '';
assert.match(html, /expected output/);
```

`MemoryFileProvider` is the repository test helper from `src/test/test-helpers.ts`; production hosts supply their own `IFileProvider`. The `uri` and `source` values in this snippet are test inputs.

Select only the backend containing the rule you changed. Assert final HTML or payload behavior rather than the existence of a declaration.

## Next references

- [Extension Model](../index.md) explains which registry field owns a change.
- [Rendering Rules Tutorial](../rules.md) implements a complete command.
- [Call Relationships](./call-relationships.md) shows runtime ownership and callback flow.
- [Metadata and Dependencies](../metadata.md) covers document-level state and dirty blocks.
