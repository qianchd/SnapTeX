# Install SnapTeX

SnapTeX's preview does not require TeX Live, MiKTeX, or another native TeX distribution. Install only the host you intend to use:

| Goal | Start with |
| --- | --- |
| Work in an existing local VS Code repository | VS Code extension |
| Try the editor without installing an extension | Static Web app |
| Install an offline-capable browser application | Web app, then PWA install |
| Store named projects on your own machine/server | Self-hosted server edition |

## VS Code extension

SnapTeX supports VS Code 1.80 and later.

1. Open the Extensions view in VS Code.
2. Search for **SnapTeX** by `qstatsite`.
3. Select **Install**.
4. Open a `.tex` file and run **SnapTeX Preview: Start** from the Command Palette.

You can also install it from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=qstatsite.snaptex).

To verify the installation, open a document containing:

```latex
\section{Hello SnapTeX}

Inline math such as $a^2+b^2=c^2$ appears in the preview.
```

Press `Ctrl+K V` on Windows/Linux or `Cmd+K V` on macOS. A preview editor should open beside the source.

## Static Web app

Open [SnapTeX Web](https://qianchd.github.io/SnapTeX/) in a modern browser. Nothing is installed and no account is required for local folders, imported workspaces, or the demo.

The available folder action depends on browser support:

- **Open Folder** uses the File System Access API and can write through to the selected directory after permission is granted. It is normally available in Chromium-based browsers.
- **Import Folder** copies supported files into a persistent browser workspace. Use it when direct directory handles are unavailable or when you want an isolated browser copy.

## Install the PWA

The static Web build is an installable Progressive Web App in browsers that expose PWA installation. Open the Web app once, wait for it to finish loading, then use the browser's **Install app** action.

The application shell can start offline after it has been cached. Direct local folders still depend on browser permissions; imported workspaces and the demo remain in browser storage.

## vscode.dev

The extension includes a browser-compatible entry and can run in `vscode.dev` or compatible hosted VS Code environments. Workspace access follows the capabilities and permissions offered by that host.

## Self-hosted editions

Do not install the server edition merely to edit local files in a browser. It is intended for named projects stored on infrastructure you control. See [Choose a deployment mode](../deployment/overview.md) when you need static hosting or authenticated remote projects.

## Next step

Continue with [Your First Preview](./getting-started.md), which explains the root document, first render, saving, and source/preview navigation.
