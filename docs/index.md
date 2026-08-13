# SnapTeX Documentation

SnapTeX is a local-first LaTeX editor and structural preview engine. It runs as a VS Code extension, a browser application, an installable offline PWA, or a self-hosted project server. The same rendering core powers every host.

<div class="doc-actions">
  <a href="./guide/getting-started">Get started</a>
  <a href="https://qianchd.github.io/SnapTeX/">Open the Web app</a>
  <a href="./deployment/overview">Deployment options</a>
</div>

## Choose your host

| Host | Best for | File storage |
| --- | --- | --- |
| VS Code extension | Editing a local repository with native editor features | Your local workspace |
| Static Web/PWA | Trying SnapTeX, offline browser editing, and portable browser workspaces | Local folder handles or browser IndexedDB |
| SnapTeX Server | Editing named projects stored on your own server | A configured server directory |

## What SnapTeX renders

SnapTeX provides fast previews for prose, headings, lists, math, theorem-like environments, figures, PDF images, tables, algorithms, citations, references, metadata, and TikZ. It performs incremental block rendering and can virtualize long previews so only viewport-near content remains mounted.

::: tip Structural preview
SnapTeX intentionally approximates LaTeX layout. Use a full TeX distribution for final pagination, package-specific typography, and publication output.
:::

## Where to go next

- [Getting Started](./guide/getting-started.md) gives the shortest path to a working preview.
- [Rendering](./features/rendering.md) lists supported constructs and expected limitations.
- [SnapTeX Server](./deployment/server.md) covers authenticated remote projects.
- [Rules Registry](./extending/rules.md) explains the supported extension points.
- [Architecture](./development/architecture.md) maps the core, host adapters, and preview runtime.
