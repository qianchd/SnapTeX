# Rule API Reference

This section documents the supported extension surface assembled through `src/rules.ts`. Use it as a lookup after choosing an extension point; the [Rendering Rules Tutorial](./rules) is the guided starting point.

These are contributor APIs compiled into SnapTeX, not commands imported by a `.tex` project and not a published npm plugin surface. Read [Source API Scope](./api/scope) first for exact code location, import paths, callback ownership, output safety, and the minimum test harness. Then use [Call Relationships](./api/call-relationships) to see where an API runs.

## Find the API by task

| Goal | Start here |
| --- | --- |
| Understand where API code belongs and who supplies callback values | [Source API Scope](./api/scope) |
| Assemble a complete custom registry | [`defineRuleRegistry`](./api/registry/define-rule-registry) |
| Add a source-text rendering rule | [Legacy rule contract](./api/contracts/legacy-rules) |
| Add a structural AST rendering rule | [AST rule contract](./api/contracts/ast-rules) |
| Read balanced LaTeX commands or groups | [`replaceLatexCommandCalls`](./api/source/replace-latex-command-calls) or [`readLatexCommandAt`](./api/source/read-latex-command-at) |
| Produce safe inline HTML | [`renderInlineLatexHtml`](./api/rendering/render-inline-latex-html) |
| Extract custom preamble metadata | [Metadata contract](./api/contracts/metadata-dependencies) |
| Re-render a block when external state changes | [`BlockDependencyRule`](./api/dependencies/collect) |
| Change block splitting behavior | [Splitter contract](./api/contracts/splitter) |
| Test a registry through the real document pipeline | [`PreviewUpdateService`](./api/testing/preview-update-service) |

## Recognize who owns a function

The spelling of a signature tells you how it reaches your code:

| Signature shape | What you do | Who supplies the arguments |
| --- | --- | --- |
| `function escapeHtml(text)` | Import and call the helper | Your code supplies every argument |
| `apply(text, renderer)` | Implement this property on a `PreprocessRule` | `SmartRenderer` calls it |
| `(input, context) => result` | Pass this function to `defineAstRenderRule` | The AST walker calls it |
| `renderer.protectHtml(...)` | Call a method on the received legacy context | `SmartRenderer` created `renderer` |
| `input.renderChildren(...)` | Call a method on the received AST input | The AST walker created `input` |
| `context.renderMath(...)` | Call a method on the received AST context | The AST renderer created `context` |

A declaration helper such as `defineAstRenderRule(...)` provides typing but does not register or execute the rule. Execution starts only after the returned callback appears in the matching `SNAP_TEX_RULES` array.

## Follow values through the pipeline

```text
src/rules.ts declaration
  -> SNAP_TEX_RULES registration
  -> parser/renderer calls your callback
  -> callback uses imported helpers and injected context methods
  -> callback returns transformed source, HTML, metadata, or dependencies
  -> the owning service consumes that return value
```

Each API page identifies the caller and the next consumer under **Call relationships**. This distinction matters: returning HTML from an AST rule is final, while returning HTML-looking text from a legacy rule is unsafe unless it has first passed through `renderer.protectHtml`.

## API categories

- **Registry functions** assemble and type-check extension definitions.
- **Legacy context** exposes output protection, inline rendering, and citation state to `PreprocessRule`.
- **Source readers** safely read balanced LaTeX syntax without ad hoc regular expressions.
- **Rendering functions** escape output and render inline LaTeX or KaTeX.
- **AST functions** inspect structural nodes and render their source or children.
- **Metadata and dependency functions** extract document state and declare block invalidation inputs.
- **Testing API** exercises a registry through parsing, diffing, scanning, and rendering.

## Function index

| Category | Functions and methods |
| --- | --- |
| Registry | [`defineRuleRegistry`](./api/registry/define-rule-registry), [`defineAstRenderRule`](./api/registry/define-ast-render-rule), [`defineBlockDependencyRule`](./api/registry/define-block-dependency-rule) |
| Legacy | [`apply`](./api/legacy/apply), [`protectHtml`](./api/legacy/protect-html), [`renderInline`](./api/legacy/render-inline), [`resolveCitation`](./api/legacy/resolve-citation), [`getCitedKeys`](./api/legacy/get-cited-keys) |
| Source | [`replaceLatexCommandCalls`](./api/source/replace-latex-command-calls), [`readLatexGroup`](./api/source/read-latex-group), [`readLatexCommandAt`](./api/source/read-latex-command-at), [`skipLatexWhitespace`](./api/source/skip-latex-whitespace), [`stripLatexComments`](./api/source/strip-latex-comments) |
| Rendering | [`escapeHtml`](./api/rendering/escape-html), [`renderMath`](./api/rendering/render-math), [`renderInlineLatexHtml`](./api/rendering/render-inline-latex-html) |
| AST | [`render`](./api/ast/render), [`readAstCommandArguments`](./api/ast/read-ast-command-arguments), [node readers](./api/contracts/ast-rules), [context methods](./api/ast/context-render-math) |
| Metadata and dependencies | [`extract`](./api/metadata/extract), [`readMetadataCommand`](./api/metadata/read-metadata-command), [`collect`](./api/dependencies/collect), [`deps.metadata`](./api/dependencies/metadata), [`deps.citedKeys`](./api/dependencies/cited-keys) |
| Testing | [`PreviewUpdateService`](./api/testing/preview-update-service), [`render`](./api/testing/render), [`renderBlockByIndex`](./api/testing/render-block-by-index), [query methods](./api/testing/get-diagnostics) |

## Supported boundary

The reference intentionally covers the APIs used to extend `SNAP_TEX_RULES`. Internal exports used only by SnapTeX implementation modules are not presented as stable extension contracts.

The legacy and AST backends are independent execution paths. A custom rule may target either backend; developers are not required to implement the same feature twice.

If an exported helper is absent from this reference, treat it as internal implementation rather than a supported extension contract. Internal APIs may still be reused by built-in modules, but extension documentation and compatibility promises do not follow them automatically.

## Definition locations

| Area | Source |
| --- | --- |
| Registry and default rules | `src/rules.ts` |
| Shared rule types | `src/types.ts` |
| Balanced source readers | `src/utils.ts` |
| Rendering helpers | `src/rule-helpers.ts` |
| AST rule contracts | `src/ast/rules/index.ts` |
| AST node readers | `src/ast/visit-utils.ts` |
| Metadata extraction | `src/metadata.ts` |
| End-to-end update service | `src/preview-update-service.ts` |

Continue with the [Rendering Rules Tutorial](./rules) for a guided implementation.
