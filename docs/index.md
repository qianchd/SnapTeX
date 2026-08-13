# SnapTeX Documentation

SnapTeX is a local-first LaTeX editor and structural preview engine for VS Code and the browser. This documentation is organized by what you are trying to do, so everyday use is not mixed with renderer internals.

<div class="doc-actions">
  <a href="./guide/">Use SnapTeX</a>
  <a href="./development/">Develop SnapTeX</a>
  <a href="https://qianchd.github.io/SnapTeX/">Open the Web app</a>
</div>

## For users

The [User Guide](./guide/index.md) starts with installation and a first preview, then explains VS Code, browser workspaces, saving, source/preview navigation, long documents, settings, and troubleshooting.

Choose this path when you want to write LaTeX rather than change SnapTeX itself.

## For self-hosters

The [Self-hosting Guide](./deployment/overview.md) separates two deployable editions:

- a static, offline-capable Web/PWA build for local and browser-stored projects;
- an authenticated server build for named projects kept on infrastructure you control.

It includes build commands, deployment layout, operation, and the server security model.

## For developers

The [Developer Guide](./development/index.md) covers repository setup, architecture, the rendering pipeline, AST internals, synchronization, performance, and testing.

All source-level extension declarations are assembled in `src/rules.ts`. The extension guide explains which registry field owns each behavior, and the [Rule API Reference](./extending/rule-api.md) documents the common functions one by one, including where callback values come from.

## Choose your host

| Host | Best for | File storage |
| --- | --- | --- |
| VS Code extension | Editing a local repository with native editor features | Your local workspace |
| Static Web/PWA | Trying SnapTeX, offline browser editing, and portable workspaces | Local folder handles or browser IndexedDB |
| SnapTeX Server | Editing named projects stored on your own server | A configured server directory |

## Preview boundary

SnapTeX renders prose, math, references, citations, figures, PDFs, tables, algorithms, theorem-like environments, metadata, and TikZ. Incremental block rendering and virtualization keep long previews responsive.

::: tip Structural preview
SnapTeX intentionally approximates LaTeX layout. Use a full TeX distribution for final pagination, package-specific typography, float placement, and publication output.
:::
