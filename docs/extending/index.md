# Extension Model

SnapTeX has one source-level assembly point: `src/rules.ts`. You declare a small object that describes new behavior, then add that object to one field of `SNAP_TEX_RULES`. The document parser or renderer reads that registry during the next preview lifecycle.

::: warning Rebuild required
These are source-level extensions, not rules loaded from a TeX project or a live VS Code setting. After editing `src/rules.ts`, rebuild SnapTeX and fully reload the preview.
:::

If you reached this page from an individual function reference, read [Source API Scope](./api/scope.md) for import locations, callback ownership, output safety, and the test harness assumed by all API pages.

## The three-step model

Every extension follows the same path:

```text
LaTeX syntax or document state
        -> one rule declaration
        -> one SNAP_TEX_RULES array
        -> existing parser/renderer service
```

For example, defining `BADGE_RENDER_RULE` alone does nothing. Adding it to `renderRules` makes the legacy renderer call its `apply` callback for each block.

```ts
const BADGE_RENDER_RULE: PreprocessRule = {
    name: 'badge',
    priority: 200,
    apply: (text, renderer) => /* transform one block */ text
};

export const SNAP_TEX_RULES = defineRuleRegistry({
    metadataExtractors: [
        BUILTIN_METADATA_EXTRACTOR,
        EDITOR_METADATA_EXTRACTOR
    ],
    renderRules: [...DEFAULT_RENDER_RULES, BADGE_RENDER_RULE],
    astRenderRules: DEFAULT_AST_RENDER_RULES,
    blockDependencyRules: DEFAULT_BLOCK_DEPENDENCY_RULES,
    splitterConfig: DEFAULT_SPLITTER_CONFIG,
    splitterRules: DEFAULT_SPLITTER_RULES
});
```

The declaration and registration remain close enough to discover from one file. The [Rendering Rules Tutorial](./rules.md) explains every line in the rule.

## The one-entry principle

An extension should be visible from `SNAP_TEX_RULES`:

```ts
export const SNAP_TEX_RULES = defineRuleRegistry({
    metadataExtractors: [/* metadata readers */],
    renderRules: [/* legacy render rules */],
    astRenderRules: [/* AST render rules */],
    blockDependencyRules: [/* external invalidation rules */],
    splitterConfig: DEFAULT_SPLITTER_CONFIG,
    splitterRules: [/* block-boundary rules */]
});
```

Custom declarations, imports, and registration belong in `src/rules.ts`. Existing shared readers and rendering helpers may be imported into that file, but an extension should not add conditionals to `document.ts`, `renderer.ts`, host adapters, or the webview runtime.

Built-in implementations are split into focused modules when they are large, such as tables or TikZ. That is an internal maintenance choice. `src/rules.ts` remains the assembly boundary that makes active behavior discoverable.

## Choose one extension point

| Desired behavior | Registry field |
| --- | --- |
| Transform source blocks in the legacy renderer | `renderRules` |
| Render parsed nodes in the AST renderer | `astRenderRules` |
| Extract preamble or document metadata | `metadataExtractors` |
| Rerender unchanged source when metadata/citations change | `blockDependencyRules` |
| Change environment/block boundaries | `splitterRules` |
| Change emergency block length limits | `splitterConfig` |

Legacy and AST rendering rules are alternatives for the selected backend. Adding a legacy rule does not require an AST counterpart, and adding an AST rule does not require a legacy counterpart.

Use this decision path:

1. If the change turns LaTeX content into preview HTML, choose `renderRules` or `astRenderRules` according to the backend you are extending.
2. If it reads document declarations such as `\title` or `\editor`, choose `metadataExtractors`.
3. If an unchanged block must rerender after metadata or citation state changes, add `blockDependencyRules` alongside the rendering feature.
4. If rendering receives the wrong block boundary, use `splitterRules`; splitter rules never generate HTML.

Do not add a dependency or splitter rule merely because a render rule is new. Most command extensions need only one render rule.

## What remains fixed infrastructure

Rules should consume these services rather than replace them:

- source storage and block spans;
- balanced LaTeX command/group readers;
- metadata and macro lifecycle;
- hashes, diffing, scanner summaries, and patch selection;
- host-neutral messages and file providers;
- preview virtualization, source sync, tooltips, PDF, and TikZ resource scheduling.

Keeping those mechanisms outside custom rules ensures that a new renderer does not accidentally break memory use, source mapping, or incremental updates.

## Development path

1. Pick one registry field from the table above.
2. Follow the [Rendering Rules Tutorial](./rules.md) for a complete command example.
3. Look up each helper in the [Rule API Reference](./rule-api.md).
4. Add metadata/dependency behavior only when the output depends on state outside the block; see [Metadata and Dependencies](./metadata.md).
5. Test the rendered behavior through `PreviewUpdateService` in the backend you changed.

For a first extension, follow the path in order. The API reference is intentionally a lookup tool; the [Rendering Rules Tutorial](./rules.md) is the runnable, end-to-end starting point.

## Extension checklist

- The change is declared and registered in `src/rules.ts`.
- The rule owns one clear syntax or behavior.
- Balanced arguments use shared readers rather than a new brace regex.
- Source text is escaped before it enters generated HTML.
- Legacy generated HTML is protected before Markdown runs.
- AST rules preserve `consumedNodes` when reading detached arguments.
- A dependency rule exists only when unchanged block source can produce changed output.
- Tests assert the final preview behavior, including malformed input promised by the rule.
