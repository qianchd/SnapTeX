# Rule API Reference

This section documents the supported extension surface exposed through `src/rules.ts`. Each callable API has its own page, with its signature, parameters, return value, call relationships, and an example.

Start with the [call relationships](./api/call-relationships) if you need to understand where an API runs. Use the categories below when you already know what you need to implement.

## Choose an entry point

| Goal | Start here |
| --- | --- |
| Assemble a complete custom registry | [`defineRuleRegistry`](./api/registry/define-rule-registry) |
| Add a source-text rendering rule | [Legacy rule contract](./api/contracts/legacy-rules) |
| Add a structural AST rendering rule | [AST rule contract](./api/contracts/ast-rules) |
| Read balanced LaTeX commands or groups | [`replaceLatexCommandCalls`](./api/source/replace-latex-command-calls) or [`readLatexCommandAt`](./api/source/read-latex-command-at) |
| Produce safe inline HTML | [`renderInlineLatexHtml`](./api/rendering/render-inline-latex-html) |
| Extract custom preamble metadata | [Metadata contract](./api/contracts/metadata-dependencies) |
| Re-render a block when external state changes | [`BlockDependencyRule.collect`](./api/dependencies/collect) |
| Change block splitting behavior | [Splitter contract](./api/contracts/splitter) |
| Test a registry through the real document pipeline | [`PreviewUpdateService`](./api/testing/preview-update-service) |

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
| AST | [`match`](./api/ast/match), [`render`](./api/ast/render), [`readAstCommandArguments`](./api/ast/read-ast-command-arguments), [node readers](./api/contracts/ast-rules), [context methods](./api/ast/context-render-math) |
| Metadata and dependencies | [`extract`](./api/metadata/extract), [`readMetadataCommand`](./api/metadata/read-metadata-command), [`collect`](./api/dependencies/collect), [`deps.metadata`](./api/dependencies/metadata), [`deps.citedKeys`](./api/dependencies/cited-keys) |
| Testing | [`PreviewUpdateService`](./api/testing/preview-update-service), [`render`](./api/testing/render), [`renderBlockByIndex`](./api/testing/render-block-by-index), [query methods](./api/testing/get-diagnostics) |

## Supported boundary

The reference intentionally covers the APIs used to extend `SNAP_TEX_RULES`. Internal exports used only by SnapTeX implementation modules are not presented as stable extension contracts.

The legacy and AST backends are independent execution paths. A custom rule may target either backend; developers are not required to implement the same feature twice.

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
