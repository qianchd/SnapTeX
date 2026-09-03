# Web App

SnapTeX Web uses CodeMirror for editing and the shared SnapTeX preview runtime for rendering. The editor, preview, project explorer, settings, and split-pane layout all run in the browser.

No account is needed for local folders, imported workspaces, or the demo. Authentication appears only when a server-enabled deployment opens a remote project.

## Welcome page choices

| Action | Result | Save destination |
| --- | --- | --- |
| **Open Folder** | Uses a browser-granted directory handle | Selected local files |
| **Import Folder** | Copies supported files into a browser workspace | IndexedDB |
| **Open Demo** | Creates/reopens the bundled example workspace | IndexedDB |
| **Open Server** | Opens a named project in a server-enabled deployment | Authenticated remote project API |

The static public edition keeps the **Open Server** entry as deployment guidance but does not call a missing project API.

Choose by desired storage behavior:

1. Use **Open Demo** when learning the interface.
2. Use **Open Folder** when edits must write directly to an existing directory and the browser supports directory handles.
3. Use **Import Folder** when you want broad browser compatibility or an isolated browser copy.
4. Use **Open Server** only on a server-enabled deployment when files should remain on that server.

Opening and importing are not equivalent. **Open Folder** keeps a live browser-granted handle; **Import Folder** copies files into IndexedDB.

## Open Folder

In browsers that implement the File System Access API, **Open Folder** keeps handles to the selected local directory. Saving writes the changed text back to the selected files after the browser grants permission.

This option is hidden when the browser does not expose directory handles.

## Import Folder

**Import Folder** copies supported project files into an IndexedDB workspace. It works independently of direct folder-write support and avoids turning every save into a download.

Imported workspaces:

- persist after closing the tab;
- keep a distinct generated project ID, so folders with the same name do not overwrite each other;
- can be reopened from **Workspaces**;
- can be re-imported with conflict detection;
- can be exported as ZIP.

Browser storage can still be cleared by the user, private-browsing policy, or storage pressure. Export important work regularly.

Re-importing a folder creates or updates a browser workspace through conflict detection. It does not grant write access back to the original directory.

## Demo workspace

The bundled demo is imported into the same browser workspace store. It is not a writable server directory and does not require a login.

Changes are saved to the demo's IndexedDB workspace, so `Ctrl+S` does not download a file. Use **Export ZIP** when you want a portable copy.

## Static and server editions

The same UI supports two build modes:

- `static` enables local folders, imports, workspaces, demo, ZIP export, and offline PWA use;
- `server` adds authenticated named projects through the same-origin project API.

The server process corrects the deployment marker in served HTML from its actual project API configuration, so the UI cannot accidentally present a static-only state when remote projects are enabled.

## Offline behavior

The static build installs a service worker that caches application assets. Open the app online once and allow the first load to finish before relying on offline use. Local and imported projects remain browser-managed data and are not uploaded by the static edition.

Remote server projects require a network connection to their server even when the application shell is cached.

## Remote changes and conflicts

An open server project checks its lightweight file revisions approximately once per second. When another process changes a project text file, SnapTeX downloads only that changed file and refreshes the editor or preview.

SnapTeX keeps the last synchronized text as a merge base. A server change replaces an unchanged browser copy directly, and edits made to different lines are merged automatically. If browser and server edits overlap, the editor displays `LOCAL`, `BASE`, and `REMOTE` conflict markers and the Diagnostics panel reports the affected path. Resolve and remove those markers before saving.

Remote saves use the file's ETag as an optimistic lock. If the server changes after the latest check but before a save, the server rejects the stale write and the same merge process runs; the browser never silently overwrites the newer server text.

## Browser capability summary

| Capability | Direct folder | Imported/demo workspace | Server project |
| --- | --- | --- | --- |
| Works without directory-handle support | No | Yes | Yes |
| Writes to an original local directory | Yes | No | No |
| Persists after closing the tab | Browser permission dependent | Yes, in IndexedDB | Yes, on the server |
| Works fully offline | Yes after the app shell is cached | Yes after the app shell is cached | No |
| Portable backup | Copy the directory | Export ZIP | Server backup policy |

## Next

- Read [Projects and Files](./projects.md) for root selection, saving, and supported file types.
- Read [Static Web and PWA](../deployment/static-web.md) to deploy a browser-only edition.
- Read [Deployment Overview](../deployment/overview.md) before enabling remote projects.
