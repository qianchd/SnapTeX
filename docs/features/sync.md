# Sync and Navigation

SnapTeX keeps source and preview navigation separate from rendering. Both the legacy and AST backends produce the same block/source map consumed by the host and preview runtime.

## Editor to preview

Forward sync uses the active source line, character position, nearby text anchors, and source ranges to choose a preview block. If virtual mode has released that block, the webview mounts it first and then reveals the target.

The reveal keeps the editor cursor's approximate vertical position in the preview. This avoids always placing a synchronized target at the top edge.

## Preview to editor

Double-clicking preview content sends:

- the block index and local click ratio;
- nearby visible words;
- AST source ranges when the AST backend produced hints;
- the clicked viewport ratio.

The host chooses the nearest matching source range and reveals it at the corresponding vertical ratio. A short highlight animation marks the resolved source.

## Automatic scrolling

Automatic sync observes scroll and cursor changes in both panes. Directional suppression locks prevent a movement initiated by one pane from being echoed back as a new movement from the other pane.

Layout changes, split-pane resizing, and preview patches temporarily suppress synchronization. This matters because virtual block mounting and changing block heights can otherwise turn one user scroll into a feedback loop.

## Virtual mode

Virtualization does not remove navigation metadata. Every block retains a lightweight shell with its source line, hash, and estimated height. Reference jumps, tooltips, and explicit sync requests can mount an offscreen block on demand.

## AST enhancement

The AST backend stores compact source hints rather than retaining complete AST trees for every block. Those hints add source spans for inline math and other structured nodes, improving fine-grained sync without reparsing during each navigation request.
