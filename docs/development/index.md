# Developer Guide

This guide is for contributors changing SnapTeX's core, host adapters, preview runtime, Web application, server, or source-level extension registry.

If you only want to install and use SnapTeX, go to the [User Guide](../guide/index.md).

## Start here

1. Follow [Development Setup](./getting-started.md) to build and test the repository.
2. Read [Architecture](./architecture.md) to learn which directory owns each concern.
3. Trace one update through the [Rendering Pipeline](./rendering-pipeline.md).
4. Use the [Extension Model](../extending/index.md) before adding a LaTeX command, environment, metadata field, dependency, or splitter behavior.
5. Consult the [Rule API Reference](../extending/rule-api.md) for exact contracts and complete parameter flow.

## Extension principle

`src/rules.ts` is the single source-level assembly point for customizable document behavior. A developer adding a rule declares it there and registers it in exactly one appropriate registry field.

This does **not** mean every extension needs both a legacy and an AST implementation. The selected backend uses its own rendering-rule array:

| Backend being extended | Registry field |
| --- | --- |
| `legacy` | `renderRules` |
| `ast(experimental)` | `astRenderRules` |

Metadata, dependency, and splitter extensions have their own backend-neutral registry fields. Do not scatter extension switches through `document.ts`, `renderer.ts`, host adapters, or webview code.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/` | Host-neutral document, rendering, diff, scanner, rules, and message contracts |
| `src/ast/` | AST parsing, artifacts, refinement, rules, and source hints |
| `src/webview/` and `media/` | Shared preview runtime and assets |
| `apps/vscode/` | VS Code activation, commands, settings, editor integration, and file provider |
| `apps/standalone/` | Browser-host-neutral editor/preview application services |
| `apps/web/` | Web UI, project backends, PWA/static build, and optional project server |
| `docs/` | VitePress user, deployment, and developer documentation |
| `test/` | Behavior-focused integration and regression tests |

## Internal topics

- [AST Backend](./ast-backend.md)
- [Sync Model](./sync-model.md)
- [Performance](./performance.md)
- [Testing](./testing.md)
