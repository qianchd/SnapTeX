# Development Setup

## Prerequisites

- Node.js 22 or later for the current development and deployment scripts;
- npm;
- VS Code when running the extension integration tests;
- Git.

The extension manifest remains compatible with VS Code 1.80 and later. The Node.js requirement above is for building the repository, not for the VS Code extension host itself.

## Install dependencies

```bash
git clone https://github.com/qianchd/SnapTeX.git
cd SnapTeX
npm ci
```

Use `npm ci` so local and CI installs follow `package-lock.json` exactly.

## Build the VS Code extension

```bash
npm run compile
```

This command type-checks, lints, and bundles the VS Code target. For active extension development:

```bash
npm run watch
```

Then launch the repository's Extension Development Host from VS Code.

## Run tests

```bash
npm test
```

The test lifecycle compiles tests and production bundles, lints source, runs server tests, and launches the VS Code test host.

For faster targeted checks:

```bash
npm run check-types
npm run lint
npm run compile-tests
npm run web:test-server
```

## Run the Web app

Build and serve the static Web edition:

```bash
npm run web:serve
```

For source-oriented development, build the Web bundle and serve from the repository tree:

```bash
npm run web:serve-source
```

The terminal prints the local URL. Do not open the HTML through a `file:` URL; workers, modules, resource loading, and PWA behavior require an HTTP origin.

## Run this documentation

```bash
npm run docs:dev
```

Before committing documentation, run:

```bash
npm run docs:build
```

The production build checks internal links. `npm run web:build-static` also builds the docs and places them under `dist-web/docs/`.

## Where to make a change

| Goal | Start in |
| --- | --- |
| Add or customize LaTeX rendering behavior | `src/rules.ts` and the [Extension Model](../extending/index.md) |
| Change document parsing, spans, or includes | `src/document.ts`, `src/splitter.ts`, `src/ast/` |
| Change incremental diff/render behavior | `src/diff.ts`, `src/renderer.ts`, `src/preview-update-service.ts` |
| Change preview DOM, virtualization, PDF, TikZ, or sync UI | `src/webview/`, `media/` |
| Change VS Code integration | `apps/vscode/` |
| Change shared standalone editor behavior | `apps/standalone/` |
| Change Web projects, storage, toolbar, PWA, or server | `apps/web/` |

## Development discipline

Before adding a helper, search for an existing balanced LaTeX reader, sanitizer, renderer, source-map utility, or host-neutral contract. Rendering extensions should reuse the API documented in the [Rule API Reference](../extending/rule-api.md) instead of creating command-specific brace regexes or a second rendering pipeline.

Keep tests behavior-focused. Assert generated preview HTML, updates, mappings, or rejected server operations rather than checking that a function name or source string exists.
