# Static Web and PWA

Use this edition when the host serves application assets only and users keep projects in local folders or browser workspaces. It requires no Node process after the build is deployed.

## Build

```bash
npm ci
npm run web:build-static
```

The command builds the Web application and this documentation site. The deployable tree is written to `dist-web/`, with documentation under `dist-web/docs/`.

Serve the output over HTTP for local verification:

```bash
npm run web:serve-static
```

Opening `index.html` directly with a `file:` URL is not supported because module workers, service workers, and browser resource policies require an HTTP origin.

## GitHub Pages

The repository workflow `.github/workflows/pages.yml` is manually dispatched. It installs exact dependencies, runs `web:build-static` with the repository Pages base path, uploads `dist-web`, and deploys the artifact through GitHub Pages.

Enable GitHub Pages with **GitHub Actions** as the source, then run **Deploy SnapTeX Web** from the Actions tab.

## Other static hosts

Upload the contents of `dist-web/` without changing their relative layout. Configure the host to:

- serve `index.html` at the deployment root;
- preserve `service-worker.js`, `manifest.webmanifest`, `.nojekyll`, and compressed TikZ assets;
- use correct MIME types for JavaScript modules, WebAssembly, gzip files, and web manifests;
- serve over HTTPS outside localhost.

## PWA and updates

The service worker precaches versioned application assets. Navigation is network-first and falls back to the cached shell when offline. API and authentication routes are never intercepted.

Each build hashes its asset set into a new cache name. On activation, the new worker removes older caches within the same registration scope.

## Static limitations

**Open Server** displays guidance instead of calling unavailable APIs. The static edition cannot store projects on the hosting server. Use direct local folders, IndexedDB workspaces, or deploy the [server edition](./server.md).

## Verify the deployment

1. Open the deployed root and confirm the welcome page identifies the static edition.
2. Open the demo and render text, math, one image, and one TikZ block.
3. Import a small folder, save a change, reload the page, and reopen the workspace.
4. Install the PWA, load it once, disconnect the network, and confirm the shell plus an imported workspace still open.
5. Select **Open Server** and confirm it shows deployment guidance rather than sending an API request.
