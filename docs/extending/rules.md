# Rules Registry

SnapTeX exposes one registry in `src/rules.ts`. It is the supported place to assemble document-specific metadata extraction, block splitting hints, rendering rules, dependency rules, and AST rendering rules.

```ts
export const SNAP_TEX_RULES = defineRuleRegistry({
    metadataExtractors: [
        BUILTIN_METADATA_EXTRACTOR,
        EDITOR_METADATA_EXTRACTOR
    ],
    renderRules: DEFAULT_RENDER_RULES,
    astRenderRules: DEFAULT_AST_RENDER_RULES,
    blockDependencyRules: DEFAULT_BLOCK_DEPENDENCY_RULES,
    splitterConfig: DEFAULT_SPLITTER_CONFIG,
    splitterRules: DEFAULT_SPLITTER_RULES
});
```

The registry is captured for one renderer/document lifecycle. After changing rules, rebuild and fully reload the preview so block boundaries, metadata, dependencies, and cached HTML all use the same registry.

## Preprocess rules

```ts
interface PreprocessRule {
    name: string;
    priority: number;
    apply(text: string, renderer: RenderContext): string;
}
```

Preprocess rules run in ascending priority before Markdown rendering. Use existing shared LaTeX readers from `src/utils.ts`; do not add a new bracket or command parser for one rule.

Generated HTML must pass through `renderer.protectHtml(...)`:

```ts
const noteRule: PreprocessRule = {
    name: 'note',
    priority: 175,
    apply: (text, renderer) => text.replace(
        /\\note\{([^{}]*)\}/g,
        (_match, content) => renderer.protectHtml(
            'note',
            `<aside class="latex-note">${escapeHtml(content)}</aside>`,
            'block'
        )
    )
};
```

Protection prevents Markdown from escaping generated markup or exposing it as literal source. Escape user-controlled text before embedding it in generated HTML.

## Splitter rules

Splitter rules describe block structure without performing rendering:

| Kind | Purpose |
| --- | --- |
| `ignored-env` | Ignore an environment as a standalone block boundary. |
| `transparent-env` | Let internal content split normally; optionally preserve begin/end wrappers. |
| `split-env` | Start or end a structural block at the environment. |
| `no-emergency-split-env` | Allow a long valid environment more lines before emergency recovery. |
| `no-emergency-split-begin-token` | Protect a long brace construct from ordinary emergency splitting. |
| `emergency-split-end-env` | Permit recovery after a recognized closing environment. |

`splitterConfig.maxBlockLines` controls ordinary emergency splitting. `maxNoEmergencySplitLines` is the upper bound for protected long constructs; it prevents a missing closing token from absorbing the remainder of the document.

Splitter rules should express structural ownership only. Styling and HTML belong in render rules.

## AST render rules

AST rules receive parsed node structure and return rendered HTML plus optional metadata. They are used only by `ast(experimental)` and are best for constructs whose nested arguments or source spans are unreliable under regular expressions.

Use `defineAstRenderRule(...)` and the shared `readAstCommandArguments(...)` helper. A rule should return no match when it does not own the node, allowing the next AST rule or the normal rendering path to continue.

## Stable infrastructure

Rules should not reimplement:

- document source storage and block spans;
- hash diffing and patch selection;
- counter scanning;
- host/webview messages;
- virtualization and resource lifetimes;
- file access.

Those services are intentionally fixed so custom rendering cannot invalidate synchronization or memory behavior.
