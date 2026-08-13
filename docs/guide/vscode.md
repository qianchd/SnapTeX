# VS Code Extension

## Commands and shortcuts

| Action | Command | Windows/Linux | macOS |
| --- | --- | --- | --- |
| Open or refresh preview | `SnapTeX Preview: Start` | `Ctrl+K V` | `Cmd+K V` |
| Toggle automatic sync | `SnapTeX: Toggle Auto Scroll` | `Ctrl+Alt+A` | `Cmd+Alt+A` |
| Sync cursor to preview | `SnapTeX: Sync to Preview` | `Ctrl+Alt+M` | `Cmd+Alt+M` |

The preview command also appears in the editor title for LaTeX documents.

## Forward and reverse sync

Forward sync maps the active editor position to a document block, mounts that block when virtual mode is enabled, and preserves the cursor's approximate viewport ratio. Reverse sync uses a double-click location and nearby source anchors to reveal the corresponding editor range.

Automatic scroll synchronization is bidirectional. SnapTeX suppresses feedback while the opposite pane is applying a synchronized movement, preventing the two panes from repeatedly moving each other.

## Root files and included resources

SnapTeX resolves `\input`, `\includegraphics`, bibliography files, and related resources through the VS Code workspace. Start the preview from the root `.tex` file that owns the preamble. When switching tabs, `snaptex.renderOnSwitch` controls whether the preview follows the new editor automatically.

## Settings

Open VS Code Settings and search for **SnapTeX**. See the complete [settings reference](../reference/settings.md), including virtual mode, update delay, memory diagnostics, and the experimental AST backend.

## vscode.dev

The extension has a browser-compatible entry and can run in `vscode.dev` or a compatible hosted VS Code environment. Files and workspace access remain subject to the host's browser file-system capabilities.
