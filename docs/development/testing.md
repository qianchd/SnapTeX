# Testing

Run the complete suite after installing the locked dependencies:

```bash
npm ci
npm test
```

`npm test` checks types, lints, compiles the tests, and then runs the four layers below. Only the VS Code layer launches an application. Tests use synthetic projects and temporary directories; they do not contact a deployed SnapTeX server or require private documents, credentials, or a TeX installation.

## Test layers

| Layer | Source | What it verifies |
| --- | --- | --- |
| Shared and Web host | `src/test/*.test.ts`, except `web-assets.test.ts` | Rendering, source maps, incremental updates, pagination, CodeMirror state, local/IndexedDB/remote project behavior |
| Server | `apps/web/server.test.mjs` | Real HTTP requests, session/CSRF protection, traversal restrictions, revision-checked writes, external file changes through SSE, PDF/SyncTeX API responses |
| Production Web assets | `src/test/web-assets.test.ts` | Static build output, asset serving, hashes, PWA cache installation and offline routing, PDF/TikZ runtime asset availability |
| VS Code integration | `src/test/vscode/*.test.ts` | Activation of the production bundle, registered commands, real file URIs, dirty editor reads, rendering and source maps through the VS Code adapter |

The shared tests run in Node, not in a VS Code process. They exercise the same `PreviewUpdateService` used by both hosts. For behavior shared by legacy and AST, use one fixture with backend parameters rather than two copies of the test.

## Focused runs

Compile TypeScript tests once before running an individual layer:

```bash
npm run compile-tests
npm run test:shared
npm run web:test-server
npm run test:web-assets
npm run test:vscode
```

`test:web-assets` builds production Web bundles and vendors before checking them. `test:vscode` builds the production extension before launching the extension host. Neither command deploys anything.

Filter shared tests by their names:

```bash
npm run test:shared -- --grep "StandaloneHost|complex booktabs"
```

Set `SNAPTEX_TEST_VSCODE_VERSION` to test a specific extension host version. The default is `stable`.

```powershell
$env:SNAPTEX_TEST_VSCODE_VERSION = '1.80.0'
npm run test:vscode
```

On Linux without a display, use `xvfb-run -a npm run test:vscode`.

## Pull request checks

`.github/workflows/ci.yml` runs for pull requests, pushes to `master`, and manual dispatch:

- Shared/Web-host and Server tests run on Linux, Windows, and macOS with Node 22.
- The production extension runs in current stable VS Code on all three operating systems, plus the declared minimum VS Code 1.80.0 on Linux.
- A Linux job builds the documentation and verifies production Web/PWA assets.

Jobs have bounded timeouts, independent matrix results, and read-only repository permissions. New commits cancel obsolete runs. Deployment remains in the separate, manually triggered Pages workflow; PR tests do not use deployment secrets.

To block merging failed PRs, enable required status checks in the repository's branch protection or ruleset. Adding a workflow alone does not enforce that policy.

## Writing useful tests

Assert the user-visible contract at the lowest level that proves it:

- Render changes should check final HTML through `PreviewUpdateService`, including expected content and the absence of unexpected raw commands or KaTeX errors. Renderer-only tests remain useful for escaping and cache behavior.
- Editor/save changes should use real CodeMirror `EditorState` transactions and history. A fake string replacement cannot prove that selection mapping or undo survives saving.
- Server tests should make real HTTP requests against a temporary project. Compilation and SyncTeX executables are injected, so tests can check the API without requiring platform-specific TeX tools.
- Asynchronous tests should wait for the expected event or write, not assume that sleeping for a fixed interval means an operation completed. SSE reads must account for chunk boundaries and close the stream afterward.
- Keep security and incremental-update tests even when they resemble a happy-path test: they guard different contracts. Remove duplicate fixture/HTML checks once a shared full-pipeline test covers the same behavior.
- Assert exact source lines, cursor positions, and scoped rendered content. Two backends returning the same wrong result, or a formula elsewhere in the document, must not make a test pass.
- Timer behavior can be checked by advancing an injected timer callback: verify the interval, pending-save cancellation, and absence of repeated writes for clean or read-only files.

Focused Mocha runs reject `.only`; zero matching shared/asset tests fail rather than producing a misleading green result.

## Coverage limits

Node tests verify generated HTML and logical behavior, not browser layout. The PWA tests execute the generated service worker with an in-memory Cache API model; they do not install a real PWA. PDF/SyncTeX tests query the official WASM parser using a real compiled fixture and native CLI reference coordinates, and separately verify authenticated sidecar delivery. They do not check PDF canvas pixels or require TeX in CI. TikZ tests verify prepared source, patches, and bundled assets; they do not prove that every picture compiles in TikZJax.

After `npm run compile-tests`, run `node tools/synctex/benchmark.mjs /path/to/project/main.pdf /path/to/project` to measure startup and forward/inverse Worker round-trip latency through the production SyncTeX client, using a locally compiled PDF's sidecar. It does not copy the project into the repository or require the native `synctex` CLI. Correctness checks use the compiled test fixture and CLI reference coordinates above. These are Node/Worker measurements, not browser rendering timings. Rebuilding the committed parser assets requires Emscripten 4.0.20 and `node tools/synctex/build.mjs`; normal builds do not require Emscripten.

Browser selection, touch dragging, scroll smoothness, PDF visibility, and actual offline installation still need manual checks. Do not describe an asset/source check as an end-to-end rendering test.

## Documentation and fixtures

```bash
npm run docs:build
```

VitePress checks internal links during the production build. Use invented names, addresses, URLs, and paths in fixtures. `src/localtestTeX` and `tex_samplecode` are local profiling/audit inputs, excluded from Git and CI.
