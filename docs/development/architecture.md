# Architecture

SnapTeX separates a host-independent rendering core from host adapters and the browser preview runtime.

```text
VS Code host ─────┐
                  ├─> LatexDocument -> SmartRenderer -> render payload
Standalone host ──┘                                      │
       ^                                                  v
       └── Web UI                              shared preview runtime
                                                        │
                                                        v
                                             HTML / PDF / TikZ blocks
```

## Core: `src/`

The core has no direct VS Code UI ownership. Its main responsibilities are:

- parse preamble metadata and project dependencies;
- split the source into block spans;
- scan counters, labels, and citations;
- diff block hashes and dependency fingerprints;
- render requested blocks;
- define host/preview message contracts;
- generate the shared preview HTML template.

`LatexDocument` owns source text, spans, hashes, metadata, diagnostics, source maps, and AST artifacts. `SmartRenderer` owns render rules, protected HTML, cached block snapshots, and patch/full render payloads.

## Standalone host: `apps/standalone/`

The standalone layer connects the core to a browser editor without committing to a particular storage backend. It owns:

- CodeMirror setup and LaTeX assistance;
- preview host orchestration;
- browser-compatible URI and file-provider primitives;
- generic project operations and project-tree helpers;
- ZIP export.

Web and a future Android wrapper can reuse this layer.

## Web host: `apps/web/`

The Web app owns browser UI and browser/server storage adapters:

- split panes, Explorer, menus, settings, welcome page, and dialogs;
- local directory handles;
- IndexedDB workspaces and demo import;
- remote project API client;
- static/PWA build;
- authenticated Node project server and deployment scripts.

These concerns do not belong in the core because they depend on browser APIs, DOM controls, HTTP, or Linux deployment.

## VS Code host: `apps/vscode/`

The extension adapter owns activation, commands, settings, editor events, workspace file access, webview creation, and VS Code reveal behavior. It passes the shared core URI-like values and message payloads rather than exposing VS Code APIs to the renderer.

## Shared preview runtime: `src/webview/` and `media/`

The preview runtime runs in both VS Code webviews and the standalone Web app. A host bridge abstracts `postMessage`. The runtime owns patches, virtualization, scroll/sync UI, tooltips, PDF canvases, and TikZ scheduling.

## Stable boundaries

The main contracts are:

- `IFileProvider` for project reads;
- `RuleRegistry` for rendering extensions;
- `RenderPayload` for full and patch updates;
- `HostToPreviewMessage` / `PreviewToHostMessage` for runtime communication;
- `BrowserProject` for Web storage backends.

New hosts should implement these boundaries instead of importing another host's UI layer.
