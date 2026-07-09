# SnapTeX Sync Model

SnapTeX keeps editor-preview synchronization host-driven. The webview reports preview intent, while the host resolves flattened source positions back to the correct original file.

## Core Coordinates

* Original file line: line number in a root, included, or subfile source document.
* Flattened line: line number after `LatexDocument` expands supported inputs into one body stream.
* Block index: preview block ordinal after splitting.
* Ratio or offset: approximate vertical position inside a rendered block.

## Editor To Preview

The host maps the active editor file and cursor line to a flattened line, finds the nearest preview block, and asks the webview to reveal the corresponding block ratio. The preview should not infer original file paths by itself.

## Preview To Editor

The webview sends a block index plus optional ratio, clicked text, and nearby anchors. The host maps the block to flattened lines, chooses the nearest source line, converts that line through the document source map, and reveals the original editor location.

In AST mode, compact source hints refine the line inside the selected block before the host converts the flattened line back to an original file. Anchors are still used to break ties for repeated text.

Sync consumes already-built source hints only. It must not trigger AST parsing. Initial AST parsing, incremental document updates, and background artifact warm-up are responsible for populating hints; when hints are missing, sync falls back to block-ratio and anchor-text heuristics.

## Virtualization

In virtual mode, not every block is mounted. Sync messages must therefore work with block indexes and shell metadata, not only live DOM nodes. Lazy block mounting should preserve block identity through `data-index` and `data-block-hash`.

## Current Limits

Long styled blocks can still make word-based reverse sync ambiguous. The current strategy combines clicked text, local anchors, block-ratio estimates, and AST source hints when available without moving source-map logic into the webview.
