# Getting Started

SnapTeX requires no TeX distribution for its preview. Choose either the VS Code extension or the Web app.

## VS Code

1. Install **SnapTeX** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=qstatsite.snaptex).
2. Open a `.tex` file.
3. Press `Ctrl+K V` on Windows/Linux or `Cmd+K V` on macOS.
4. Edit the source and watch the preview update.

Use `Ctrl+Alt+M` (`Cmd+Alt+M` on macOS) to move the preview to the editor cursor. Double-click preview content to jump back to the source.

## Web app

1. Open [SnapTeX Web](https://qianchd.github.io/SnapTeX/).
2. Choose **Open Folder** for direct folder access in a Chromium-based browser, or **Import Folder** to create a persistent browser workspace.
3. Select the root `.tex` file in Explorer and choose **Set Root** when needed.
4. Press `Ctrl+S` to save the active file.

The public Web app is a static PWA. It can work offline after the application assets have been cached, and document rendering remains local to the browser.

## Try the demo

Choose **Open Demo** on the welcome page. The demo is copied into browser storage, so editing and `Ctrl+S` behave like a normal browser workspace. Export the project as ZIP if you want to keep a portable copy.

## Expected first load

The initial render builds document metadata, block spans, numbering, references, and preview shells. TikZ and PDF runtimes load only when their blocks are requested. Later edits normally use local patches rather than replacing the complete preview.

## Next steps

- Configure the [VS Code extension](./vscode.md).
- Learn how [Web projects and storage](./web.md) differ by browser.
- Review [rendering support](../features/rendering.md).
