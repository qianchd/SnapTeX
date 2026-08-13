# Metadata and Dependency Contracts

Metadata extraction records document-level values. Dependency collection marks unchanged blocks whose HTML depends on those values.

## `MetadataExtractor`

```ts
interface MetadataExtractor {
    name: string;
    extract(text: string): MetadataExtractionResult;
}
```

[`extract`](../metadata/extract) receives document source. It may return built-in metadata fields, `custom` values, and source `ranges` that should be blanked from body rendering while preserving source mapping.

Use [`readMetadataCommand`](../metadata/read-metadata-command) to read a balanced one-argument command.

## `BlockDependencyRule`

```ts
interface BlockDependencyRule {
    name: string;
    collect(input: BlockDependencyInput): RenderDependency[];
}
```

`collect` receives block `text`, its `index`, an optional AST `artifact`, and `deps` factories. It identifies external document state that can change the block's output without changing its own source.

Dependency descriptors are cached for unchanged blocks. Their current values are fingerprinted on later updates; a changed fingerprint marks the block dirty.

## Related APIs

- [`readMetadataCommand`](../metadata/read-metadata-command)
- [`BlockDependencyRule.collect`](../dependencies/collect)
- [`deps.metadata`](../dependencies/metadata)
- [`deps.citedKeys`](../dependencies/cited-keys)
- [Metadata and Dependencies Tutorial](../../metadata)
