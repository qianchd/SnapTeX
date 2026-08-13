# Projects and Files

## Project root

A project contains one root `.tex` document plus optional included text, bibliography, style, class, image, and PDF files. SnapTeX resolves relative paths from the active root document.

In the Web app, select a `.tex` file and use **Set Root**. In VS Code, start the preview from the intended root file.

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

## Included TeX files

SnapTeX follows `\input{...}` for preview content and source mapping. Use paths relative to the root document. The preview is still structural: package loading and arbitrary TeX file execution are intentionally restricted.
