# Metadata and Dependency Contracts

<!--@include: ../../../.vitepress/partials/api-context.md-->

Metadata extraction records document-level values. Dependency collection marks unchanged blocks whose HTML depends on those values.

```text
document source -> MetadataExtractor -> document.metadata
changed block   -> BlockDependencyRule -> stored descriptors
later update    -> descriptor values + source hash -> dirty block selection
```

An extractor is required to create a custom metadata value. A dependency rule is required only when another block can keep identical source while rendering from that changed value.

## `MetadataExtractor`

```ts
type MetadataExtractor = (text: string) => MetadataExtractionResult;
```

The [extractor callback](../metadata/extract) receives document source. It may return built-in metadata fields, `custom` values, and source `ranges` that should be blanked from body rendering while preserving source mapping.

Use [`readMetadataCommand`](../metadata/read-metadata-command) to read a balanced one-argument command.

## `BlockDependencyRule`

```ts
type BlockDependencyRule = (input: BlockDependencyInput) => RenderDependency[];
```

The callback receives block `text`, its `index`, an optional AST `artifact`, and `deps` factories. It identifies external document state that can change the block's output without changing its own source.

Dependency descriptors are cached for unchanged blocks. Their current values are fingerprinted on later updates; a changed fingerprint marks the block dirty.

Neither contract renders HTML. Rendering rules consume the metadata after `LatexDocument` has merged extractor results.

## Related APIs

- [`readMetadataCommand`](../metadata/read-metadata-command)
- [`BlockDependencyRule`](../dependencies/collect)
- [`deps.metadata`](../dependencies/metadata)
- [`deps.citedKeys`](../dependencies/cited-keys)
- [Metadata and Dependencies Tutorial](../../metadata)
