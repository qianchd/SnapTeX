# SnapTeX Documentation

SnapTeX is a local-first LaTeX editor and structural preview engine for VS Code and the browser. Choose the path that matches what you want to accomplish; everyday use, deployment, and source development are documented separately.

<div class="doc-actions">
  <a href="./guide/">Use SnapTeX</a>
  <a href="./development/">Develop SnapTeX</a>
  <a href="https://qianchd.github.io/SnapTeX/">Open the Web app</a>
</div>

## For users

Start with the [User Guide](./guide/index.md) when you want to edit and preview LaTeX. It leads from choosing a host to opening a first project, saving safely, navigating between source and preview, and checking supported rendering.

Choose this path when you want to write LaTeX rather than change SnapTeX itself.

## For self-hosters

The [Self-hosting Guide](./deployment/overview.md) separates two deployable editions:

- a static, offline-capable Web/PWA build for local and browser-stored projects;
- an authenticated server build for named projects kept on infrastructure you control.

It includes build commands, deployment layout, operation, and the server security model.

## For developers

The [Developer Guide](./development/index.md) covers repository setup, architecture, the rendering pipeline, AST internals, synchronization, performance, and testing.

All source-level extension declarations are assembled in `src/rules.ts`. The extension guide explains which registry field owns each behavior, and the [Rule API Reference](./extending/rule-api.md) documents the common functions one by one, including where callback values come from.

## Find a topic directly

| I want to... | Read |
| --- | --- |
| Try SnapTeX immediately | [Your First Preview](./guide/getting-started.md) |
| Decide between VS Code, browser storage, and server projects | [User Guide](./guide/index.md#choose-one-host) |
| Understand what will and will not render | [Rendering Support](./features/rendering.md) |
| Fix a preview or synchronization problem | [Troubleshooting](./guide/troubleshooting.md) |
| Build and change the repository | [Developer Guide](./development/index.md) |
| Add a LaTeX rendering rule | [Rendering Rules Tutorial](./extending/rules.md) |
| Deploy the Web or server edition | [Deployment Overview](./deployment/overview.md) |

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
