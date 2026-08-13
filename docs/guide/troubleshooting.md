# Troubleshooting

Start with the symptom below. SnapTeX is a structural preview, so a difference from final TeX layout is not automatically a rendering failure.

## The preview is blank on first open

1. Confirm that the active editor is a `.tex` file.
2. Run **SnapTeX Preview: Start** again after VS Code has finished activating extensions.
3. Reopen the preview if the webview was created while the extension host was still starting.
4. Open **Developer: Toggle Developer Tools** and look for a `[SnapTeX]` error when the problem persists.

## Included content or resources are missing

The preview must be rooted at the document that owns the preamble and relative paths.

- In VS Code, open the intended root `.tex` file and run the preview command from it.
- In the Web app, select that file and use **Set Root**.
- Check that `\input`, `\includegraphics`, and `\bibliography` paths are relative to the root document and that the target files are inside the project.

## Changes do not appear

- Confirm that live preview is enabled. When it is disabled, save the file to render.
- Backend and virtual-mode changes require a complete preview reload; SnapTeX performs this for the current root when the setting changes.
- If only a remote resource changed, reopen or refresh the root project so the host reads the new file state.

## Sync jumps to the wrong place

- Make sure the preview belongs to the current root document.
- Use explicit forward sync (`Ctrl+Alt+M` or `Cmd+Alt+M`) after a large editor jump.
- Double-click visible words near the intended preview position instead of empty margins.
- Reopen the preview after switching processing backends, because block boundaries and source hints belong to one backend lifecycle.

Virtual mode keeps source metadata for unmounted blocks. Explicit sync and reference jumps should mount distant targets automatically; a failure to do so is a bug worth reporting with a small source example.

## The Web app cannot open a folder directly

The browser does not expose the required File System Access API. Use **Import Folder** instead. Imported projects save to IndexedDB and can be exported as ZIP; they do not turn each save into a download.

## Browser work disappeared

IndexedDB is browser-managed storage. It may be cleared manually, by private-browsing policy, or under storage pressure. Reopen an existing workspace from **Workspaces** when it still exists, and export important projects regularly.

## The PWA does not start offline

Open the deployed application online once and wait for the first load to complete. The service worker caches application assets after registration. A remote server project still requires its server even when the application shell is cached.

## TikZ does not render

TikZ loads a bundled e-TeX/TikZJax runtime when its block is mounted. Check the browser console for the first TeX error, not only a later `input.dvi` message.

- Verify balanced TikZ syntax and preamble definitions.
- Reduce unsupported package behavior to a small picture.
- Remember that TikZJax does not include every native TeX package.
- Reopening the preview resets the current webview render session; clearing site data also removes browser-side TikZ caches.

## A table, algorithm, or theorem looks different from TeX

SnapTeX renders a readable structural approximation. It supports common table cells, notes, algorithm statements, theorem wrappers, captions, and labels, but it does not execute arbitrary class/package layout logic. Check [Rendering Support](../features/rendering.md) before treating typography or placement differences as defects.

## Report a reproducible problem

Include:

1. the smallest LaTeX source that still fails;
2. whether the selected backend is `legacy` or `ast(experimental)`;
3. the host: VS Code, static Web/PWA, or server Web;
4. the first relevant console or extension-host error;
5. whether the same source works after reopening the preview.

Do not include private manuscripts, credentials, server paths, or personal data in a public issue.
