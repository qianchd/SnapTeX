# Sync and Navigation

SnapTeX can move from source to preview, from preview to source, or keep the panes aligned automatically. These controls are available in both the legacy and AST backends.

## Source to preview

Place the editor cursor at the content you want to reveal, then use:

| Host | Action |
| --- | --- |
| VS Code | `Ctrl+Alt+M` on Windows/Linux or `Cmd+Alt+M` on macOS |
| Web | `Ctrl+Alt+M` (`Cmd+Alt+M` where supported) |

SnapTeX reveals the corresponding preview block and tries to preserve the cursor's vertical position in the viewport instead of always placing it at the top.

This explicit command is useful after:

- searching or jumping a long distance in the editor;
- moving to a block that virtual mode has not mounted;
- disabling automatic sync;
- opening an included source file while the preview remains rooted at `main.tex`.

## Preview to source

Double-click visible preview content. SnapTeX reveals the closest matching source range and briefly highlights it.

Click text, math, a table cell, or another visible element rather than the blank margin. When the same words appear several times in a long block, the click position and nearby source anchors help select the closest occurrence.

## Automatic sync

Automatic source/preview synchronization is enabled by default.

- In VS Code, use `Ctrl+Alt+A` (`Cmd+Alt+A` on macOS) to toggle it.
- In the Web app, use **Settings > Auto scroll sync**.

Scroll or move the caret normally. SnapTeX suppresses the reverse event while one pane is applying a synchronized movement, so the panes do not repeatedly pull each other back.

During split-pane resizing or a preview layout update, synchronization pauses briefly. This prevents changing block heights from being mistaken for a user scroll.

## References and tooltips

Click a rendered `\ref`, `\eqref`, or supported citation link to reveal its preview target. Hovering a reference opens contextual content that includes the target block and neighboring blocks when available.

Virtual mode retains anchors even when target HTML is unmounted. The requested block is mounted before the jump or tooltip is shown.

## AST precision

When `ast(experimental)` is selected, stored source hints can narrow inline math and other structured nodes. Navigation consumes those hints; it does not reparse a block every time you synchronize.

The ordinary block/source map still exists, so the same commands and webview message protocol work in either backend.

## When sync looks wrong

1. Confirm that the preview is rooted at the correct document.
2. Use the explicit source-to-preview shortcut after a large jump.
3. Reopen or fully reload the preview after switching backends.
4. Double-click visible content instead of an empty area.
5. See [Troubleshooting](../guide/troubleshooting.md#sync-jumps-to-the-wrong-place) for reporting details.
