# Web App

SnapTeX Web uses CodeMirror for editing and the shared SnapTeX preview runtime for rendering. The editor, preview, project explorer, settings, and split-pane layout all run in the browser.

## Welcome page choices

| Action | Result | Save destination |
| --- | --- | --- |
| **Open Folder** | Uses a browser-granted directory handle | Selected local files |
| **Import Folder** | Copies supported files into a browser workspace | IndexedDB |
| **Open Demo** | Creates/reopens the bundled example workspace | IndexedDB |
| **Open Server** | Opens a named project in a server-enabled deployment | Authenticated remote project API |

The static public edition keeps the **Open Server** entry as deployment guidance but does not call a missing project API.

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
