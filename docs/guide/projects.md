# Projects and Files

This page describes project ownership and saving in every host. Three concepts are independent:

| Concept | Answers |
| --- | --- |
| Root document | Which preamble, macros, includes, bibliography, numbering, and relative paths define the preview? |
| Active file | Which file is currently open and receiving editor changes? |
| Storage backend | Where does Save write the active file? |

The root and active file may differ. The storage backend changes between VS Code, direct folders, browser workspaces, and remote projects without changing LaTeX rendering semantics.

## Project root

A project contains one root `.tex` document plus optional included text, bibliography, style, class, image, and PDF files. SnapTeX resolves relative paths from the active root document.

In the Web app, select a `.tex` file and use **Set Root**. In VS Code, start the preview from the intended root file.

Changing the root performs a complete document load. This is necessary because preamble macros, metadata, bibliography state, block boundaries, numbering, and source maps all belong to one root lifecycle.

::: warning Set the root before debugging rendering
Starting from an included chapter can make its prose appear while macros, bibliography files, images, labels, or source mapping remain incomplete.
:::

## Supported project files

Text editing and creation are limited to common source formats:

- `.tex`, `.bib`, `.sty`, `.cls`, `.bst`
- `.md`, `.txt`

Projects may also contain preview resources such as PDF, PNG, JPEG, GIF, SVG, WebP, and BMP files. Binary resources can be read and exported but are not edited as text.

## Creating and deleting files

The Web app supports **New File** and **Delete** for supported text files. Paths are normalized inside the active project. Server projects reject traversal, hidden path segments, symbolic-link escapes, unsupported file types, and oversized writes.

## Saving

| Project type | `Ctrl+S` behavior |
| --- | --- |
| Direct local folder | Writes through the browser-granted file handle |
| Imported workspace or demo | Persists to IndexedDB |
| Server project | Sends an authenticated same-origin API write |

Unsaved files are marked in the editor state. Exporting a project creates a ZIP snapshot of the current project files.

Direct local folders and server projects have an external source of truth. Imported workspaces and the demo do not: their working copy lives in the current browser profile's IndexedDB until exported.

Saving a browser workspace updates IndexedDB; it does not write back to the directory that was originally imported. Re-import and export are explicit project-copy operations.

## Included TeX files

SnapTeX follows `\input{...}` for preview content and source mapping. Use paths relative to the root document. The preview is still structural: package loading and arbitrary TeX file execution are intentionally restricted.

## Moving between project types

- Use **Import Folder** when you want an isolated browser copy of a local project.
- Use **Export ZIP** to move an imported workspace or demo to another browser or machine.
- Extract that ZIP before using **Open Folder**; a ZIP archive is a snapshot, not a live project backend.
- A server project is selected by project name and cannot read outside the server's configured project root.

## Next

- Use [Rendering Support](../features/rendering.md) to check which project syntax is approximated.
- Use [Troubleshooting](./troubleshooting.md) when an include, image, bibliography, or source map resolves from the wrong root.
