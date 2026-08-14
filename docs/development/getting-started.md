# Development Setup

This page takes a new contributor from a clean clone to one running development target and a verified change. You do not need to launch VS Code, Web, and docs simultaneously. Run commands from the repository root unless a section says otherwise.

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

The repository includes `.vscode/launch.json`. Open the SnapTeX repository in VS Code, select **Run Extension** in Run and Debug, and press `F5`. VS Code starts the watch tasks, builds `dist/extension.js`, and opens a separate Extension Development Host. In that new window, open a `.tex` project and run **SnapTeX Preview: Start**.

Edit source in the original repository window. The watch tasks rebuild code, but an already running extension host or preview may need **Developer: Reload Window** or a preview reopen when lifecycle state changes.

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

Use [Testing Changes](./testing.md) to choose the narrowest behavior test and final verification command for the area you changed.

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

`web:serve-source` is the faster development path. `web:serve` first creates the exact static deploy tree under `dist-web/`, so use it when validating PWA paths, documentation placement, or deployment output.

## Run this documentation

```bash
npm run docs:dev
```

Before committing documentation, run:

```bash
npm run docs:build
```

The production build checks internal links. `npm run web:build-static` also builds the docs and places them under `dist-web/docs/`.

## First contribution loop

1. Reproduce the behavior in the smallest relevant host.
2. Trace ownership from the [repository map](./architecture.md) or [rendering pipeline](./rendering-pipeline.md).
3. Search for an existing parser, renderer, state owner, or test helper before adding one.
4. Make the smallest coherent source change.
5. Add or update a behavior test under `src/test/` that observes the final payload, HTML, source map, storage result, or rejected operation.
6. Run the targeted check from [Testing Changes](./testing.md), then `npm test` when the change affects the core or VS Code extension.
7. Inspect `git diff` for generated output, unrelated formatting, secrets, private paths, and stale compatibility code.

For a rendering extension, begin at [Extension Model](../extending/index.md), not in `renderer.ts`. For a host feature, keep reusable behavior in `src/` or `apps/standalone/` and leave VS Code/browser API calls in their adapters.

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

## Generated and local-only output

Do not edit build output by hand. `dist/`, `dist-web/`, `out/`, and `docs/.vitepress/dist/` are produced by scripts. Local manuscripts under `src/localtestTeX/` are for private manual testing and must not be added to public fixtures.

Never commit `apps/web/server.env`, credentials, deployment origins, private project paths, or manuscript content. Use the repository's example values such as `snaptex.example.com` and synthetic fixture data.

## Common setup failures

- If `npm ci` changes the lockfile, check that your Node/npm versions match the prerequisites and rerun from a clean dependency install.
- If `F5` opens a host without the latest extension code, confirm the `watch` task is running and reload the Extension Development Host.
- If the Web app is blank under a `file:` URL, use `npm run web:serve-source` instead.
- If VS Code tests cannot start, close stale test hosts and confirm the installed runtime can launch the version configured by `@vscode/test-cli`.
- If a docs link fails only in production, run `npm run docs:build`; VitePress reports unresolved internal links during the build.

## Next

Read [Architecture](./architecture.md) to locate the owner of the behavior you want to change, then follow one update through the [Rendering Pipeline](./rendering-pipeline.md).
