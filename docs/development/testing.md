# Testing

## Core checks

```bash
npm run check-types
npm run lint
npm run compile-tests
```

The test suite emphasizes rendered behavior, source mapping, block updates, metadata, tables, TikZ source preparation, Web assets, and host-neutral contracts. Avoid tests that merely assert source-code strings or preserve obsolete corner-case implementations.

## VS Code tests

```bash
npm test
```

`pretest` compiles tests and extension bundles, runs lint, and executes the independent server tests before launching the VS Code test host.

## Web and server tests

```bash
npm run web:test-server
npm run web:build-static
npm run web:build-server
```

Server tests exercise authentication, CSRF, project manifests, constrained reads/writes, path traversal rejection, symbolic links, source-server allowlists, and deployment mode delivery.

Static asset tests verify PWA output, required PDF/TikZ assets, service-worker routing, and static/server build markers.

## Documentation

```bash
npm run docs:dev
npm run docs:build
```

VitePress reports broken internal links during production build. The static Web build also builds documentation and copies it to `dist-web/docs/`, matching GitHub Pages deployment.

## TikZ smoke test

The TikZ smoke path runs the bundled worker/runtime against a representative document and checks for a generated DVI/SVG result rather than merely matching prepared source text. Keep runtime assets installed before running it.

## Test data

Fixtures must use invented names, email addresses, institutions, URLs, and project paths. `src/localtestTeX` is reserved for local long-document profiling and is excluded from Git.
