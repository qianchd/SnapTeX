# VS Code Extension

The VS Code host uses your existing workspace, editor tabs, save commands, file permissions, and language tooling. SnapTeX adds a side-by-side structural preview and source navigation.

## Typical workflow

1. Open the root `.tex` document that owns the preamble.
2. Run **SnapTeX Preview: Start** or press `Ctrl+K V` (`Cmd+K V` on macOS).
3. Edit any included `.tex` file while keeping the preview rooted at the main document.
4. Use explicit sync after a large editor jump, or leave automatic sync enabled.
5. Use your normal VS Code save and Git workflow.

## Commands and shortcuts

| Action | Command | Windows/Linux | macOS |
| --- | --- | --- | --- |
| Open or refresh preview | `SnapTeX Preview: Start` | `Ctrl+K V` | `Cmd+K V` |
| Toggle automatic sync | `SnapTeX: Toggle Auto Scroll` | `Ctrl+Alt+A` | `Cmd+Alt+A` |
| Sync cursor to preview | `SnapTeX: Sync to Preview` | `Ctrl+Alt+M` | `Cmd+Alt+M` |

The preview command also appears in the editor title for LaTeX documents.

## Forward and reverse sync

Forward sync maps the active editor position to a preview block, mounts that block when virtual mode is enabled, and preserves the cursor's approximate viewport ratio. Reverse sync uses a double-click location and nearby visible content to reveal the corresponding editor range.

Automatic scroll synchronization is bidirectional. SnapTeX suppresses feedback while the opposite pane is applying a synchronized movement, preventing the two panes from repeatedly moving each other.

## Root files and included resources

SnapTeX resolves `\input`, `\includegraphics`, bibliography files, and related resources through the VS Code workspace. Start the preview from the root `.tex` file that owns the preamble. When switching tabs, `snaptex.renderOnSwitch` controls whether the preview follows the new editor automatically.

If the preview was started from an included file, relative resources, macros, metadata, citations, and source mapping may be incomplete. Return to the root file and run the preview command again.

## Settings

Open VS Code Settings and search for **SnapTeX**. See the complete [settings reference](../reference/settings.md), including virtual mode, update delay, memory diagnostics, and the experimental AST backend.

## vscode.dev

The extension has a browser-compatible entry and can run in `vscode.dev` or a compatible hosted VS Code environment. Files and workspace access remain subject to the host's browser file-system capabilities.

## Next

- Read [Projects and Files](./projects.md) when the root file differs from the active editor.
- Read [Sync and Navigation](../features/sync.md) for automatic and explicit positioning.
- Use [Troubleshooting](./troubleshooting.md) when a preview is blank or resources resolve from the wrong directory.
