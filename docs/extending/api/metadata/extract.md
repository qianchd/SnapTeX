# `MetadataExtractor.extract`

Extracts document-level metadata and source ranges from LaTeX source.

## Signature

```ts
extract(text: string): MetadataExtractionResult
```

## Returns

A partial metadata result. It may include built-in metadata fields, `custom` scalar values, and `ranges` to blank from ordinary body rendering.

The input has already passed through comment masking: each unescaped comment body is shortened to `%`, while line structure is preserved. `\\today` has also been expanded before extractors run.

## Call relationships

- **Called by:** `LatexDocument` during metadata parsing, in registry array order.
- **Usually calls:** [`readMetadataCommand`](./read-metadata-command) or shared balanced readers.
- **Output merged into:** `PreambleData`; later non-empty values can replace earlier values.

```ts
extract: source => {
    const editor = readMetadataCommand(source, 'editor');
    return editor
        ? { custom: { editor: editor.content }, ranges: [editor.range] }
        : {};
}
```

Return `ranges` only for declarations that should disappear from body output. The document model preserves line structure needed by source mapping.

## See also

- [Metadata and dependency contract](../contracts/metadata-dependencies)
- [`readMetadataCommand`](./read-metadata-command)
