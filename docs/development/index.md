# Developer Guide

This guide is for contributors changing SnapTeX's rendering core, host adapters, preview runtime, Web application, server, or source-level extension registry. Start from the behavior you want to change and identify its owner before opening individual API pages.

If you only want to install and use SnapTeX, go to the [User Guide](../guide/index.md).

## Choose a development path

| Goal | Read first | Main boundary |
| --- | --- | --- |
| Fix or extend LaTeX rendering | [Extension Model](../extending/index.md) | `SNAP_TEX_RULES` in `src/rules.ts` |
| Change parsing, diffing, scanning, or rendering state | [Rendering Pipeline](./rendering-pipeline.md) | Host-neutral `src/` |
| Change preview DOM, virtualization, sync, PDF, or TikZ behavior | [Architecture](./architecture.md) | `src/webview/` and `media/` |
| Change VS Code commands or editor integration | [Architecture](./architecture.md) | `apps/vscode/` |
| Change browser editing or project storage | [Architecture](./architecture.md) | `apps/standalone/` and `apps/web/` |
| Deploy or secure remote projects | [Self-hosting Guide](../deployment/overview.md) | `apps/web/server.mjs` and `apps/web/deploy/` |

You do not need to read every internal page before making a focused change. Rendering extensions normally follow the extension guide; host and lifecycle changes normally follow architecture and pipeline documentation.

## Core reading path

1. Follow [Development Setup](./getting-started.md) to build and test the repository.
2. Read [Architecture](./architecture.md) to learn which directory owns each concern.
3. Trace one update through the [Rendering Pipeline](./rendering-pipeline.md).
4. Read [Testing Changes](./testing.md) before choosing a fixture or assertion level.
5. For LaTeX syntax support, continue with the [Extension Model](../extending/index.md) and then consult the [Rule API Reference](../extending/rule-api.md) only for exact contracts.

After setup, make one small change and run the narrowest relevant check before the full suite. The [Development Setup](./getting-started.md#first-contribution-loop) page gives a repeatable workflow.

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
| `src/test/` | Behavior-focused integration and regression tests |

## Find the state owner

| State or behavior | Owner | Avoid placing it in |
| --- | --- | --- |
| Root source, includes, metadata, spans, source maps | `LatexDocument` | Host UI or webview DOM code |
| Block hashes, dependencies, numbering inputs, render snapshots | `SmartRenderer` and scanner/diff services | Individual rules |
| Full/patch lifecycle coordination | `PreviewUpdateService` | VS Code and Web duplicated flows |
| Editor selection, active file, project operations | Host adapter or `apps/standalone/` | Renderer core |
| Mounted DOM, shell heights, tooltips, PDF/TikZ scheduling | Shared preview runtime | `LatexDocument` |
| LaTeX syntax-to-preview behavior | Registry declarations and shared render helpers | Host adapters |

When a bug crosses layers, fix the first owner that produces incorrect data. For example, an incorrect source span belongs upstream of webview synchronization; a correct span revealed at the wrong DOM position belongs in the preview runtime.

## Core terms

| Term | Meaning |
| --- | --- |
| **Host** | VS Code or the standalone browser application that supplies files, settings, and UI events. |
| **Core** | Host-neutral document, renderer, scanner, diff, rule, and message code under `src/`. |
| **Preview runtime** | Browser code that receives render payloads and owns DOM patches, virtualization, sync UI, PDF, and TikZ work. |
| **Block** | A source span used for hashing, scanning, rendering, patching, virtualization, and navigation. |
| **Registry** | The lifecycle snapshot of metadata, rendering, dependency, and splitter declarations assembled as `SNAP_TEX_RULES`. |
| **Artifact/hint** | Compact AST-derived structure stored for AST rendering or more precise source navigation; it is not a retained full-document AST. |
| **Full update** | A complete preview-state replacement, used for initial load and structural resets. |
| **Patch update** | A changed-block update that preserves unrelated DOM and heavy resources. |

## Deep dives

- [AST Backend](./ast-backend.md)
- [Sync Model](./sync-model.md)
- [Performance](./performance.md)

Use these pages after the architecture and rendering pipeline when a change reaches the corresponding subsystem. Testing remains part of the core reading path because every contribution needs it.

## Definition of done

A change is ready when ownership is clear, host-neutral code remains outside host adapters, existing shared readers/renderers are reused, behavior-focused tests cover the affected pipeline, and `npm run check-types`, `npm run lint`, plus the relevant build or test command pass.
