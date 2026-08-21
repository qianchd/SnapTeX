# Sync Model

Read this page when changing cursor-to-preview sync, preview-to-source navigation, automatic scrolling, or virtualized targets. The document model supplies source spans and optional AST hints; the preview protocol and host adapters consume them.

```text
document block span + optional source hint
  -> host-neutral sync message
  -> preview or editor reveal
  -> direction-specific feedback suppression
```

## Shared source map

Each rendered block maps to a source span and starting line. This block-level map is shared by the VS Code and standalone hosts and remains available when the block's HTML is virtualized away.

Included files are flattened for parsing, but the document does not retain two arrays with one entry per flattened line. It stores consecutive mappings as compact segments. Preview-to-source lookup finds the containing segment, while source-to-preview lookup selects the exact or nearest mapped line for the requested file. Hosts consume `getOriginalPosition` and `getFlattenedLine`; the segment layout is private to `LatexDocument`.

## Anchor context

Plain-text sync extracts nearby continuous words around the cursor or click location. Search widens around the current position and ranks multiple matches by distance from the estimated source line rather than choosing the first repeated word.

LaTeX syntax and inline math can interrupt ordinary word sequences. In AST mode, stored source hints provide smaller structured ranges for math and recognized nodes, reducing reliance on text search.

## Message protocol

The preview and host exchange typed messages from `src/preview-messages.ts`. Synchronization messages carry block identity, ratios, text anchors, and optional source ranges. The protocol is host-neutral; VS Code and standalone hosts translate the result into their own editor reveal APIs.

## Feedback suppression

Automatic synchronization uses direction-specific suppression windows:

- text-to-preview movement suppresses the corresponding preview-to-text event;
- preview-to-text movement suppresses the matching text-to-preview event;
- preview layout changes and split resizing cancel pending sync work.

Suppressed work is discarded rather than queued for later replay. Replaying stale scroll work was a source of chain jumps after the user stopped scrolling.

## Virtual targets

When a target block is unmounted, the preview asks virtualization to mount it, waits for its measured layout, and then performs one reveal. Shell estimates are used to approach the target without requiring all preceding DOM to exist.

## Debugging ownership

| Symptom | Inspect first |
| --- | --- |
| Wrong file, block, or source range | `LatexDocument` source map and stored hints |
| Correct target but wrong screen position | Host reveal ratio or preview reveal logic |
| Two panes move each other repeatedly | Direction-specific suppression state |
| Far target never appears | Virtual-target mount request and completion |
