# SnapTeX Android Host Plan

This folder records the Android host boundary for the standalone SnapTeX runtime. The Android app should reuse `apps/standalone` in a WebView instead of forking parser, renderer, preview, or CodeMirror logic.

## Runtime Assets

- Serve the bundled web app and preview assets through `WebViewAssetLoader`, preferably under `https://appassets.androidplatform.net/`.
- Keep KaTeX, PDF.js, TikZJax, `tex_files/*.gz`, and web bundles as packaged app assets.
- Do not add a local HTTP server unless `WebViewAssetLoader` cannot support a required asset path.

## Project Files

Android should adapt Storage Access Framework documents into `BrowserProjectFile` records:

- Text files (`.tex`, `.bib`, `.sty`, `.cls`, `.bst`, `.txt`) provide `readText`.
- Binary resources (`.pdf`, images) provide `resourceUrl` when the Android side can expose a stable WebView-readable URL.
- Writable text files can implement `BrowserWritableFileHandle` so `StandaloneHost.saveCurrentText()` keeps the same flow as desktop browsers.

## Defaults

The Android shell should keep the same memory-friendly defaults as the web and VS Code hosts:

- virtual mode enabled
- lazy PDF loading
- lazy TikZJax loading
- bounded preview-side HTML/resource caches

