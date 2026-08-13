# Metadata and Dependencies

Metadata extraction and block dependencies solve different problems:

- extractors read document-level values from source;
- dependency rules declare which rendered blocks must refresh when those values change.

## Custom metadata extractor

The built-in example stores `\editor{...}` at `metadata.custom.editor`:

```ts
export const EDITOR_METADATA_EXTRACTOR = {
    name: 'editor-example',
    extract: (source: string) => {
        const editor = readMetadataCommand(source, 'editor');
        return editor ? {
            custom: { editor: editor.content },
            ranges: [editor.range]
        } : {};
    }
};
```

Register it in `SNAP_TEX_RULES.metadataExtractors`. Custom fields are stored beneath `metadata.custom`; built-in title, author, affiliation, email, date, macro, bibliography, and TikZ fields remain directly on the structured preamble data.

Returning source ranges lets the document model exclude metadata declarations from normal body rendering while preserving line mapping.

## Dependency rule

A block dependency rule identifies dependencies only when a block's source hash changes or the block is first created. Unchanged blocks reuse the same dependency list and only recompute the dependency fingerprint.

```ts
const maketitleDependency = defineBlockDependencyRule({
    name: 'maketitle',
    collect: ({ text, artifact, deps }) => {
        const ownsMaketitle = artifact
            ? artifact.metadata.macros.includes('maketitle')
            : text.includes('\\maketitle');
        return ownsMaketitle
            ? [deps.metadata('title'), deps.metadata('custom.editor')]
            : [];
    }
});
```

Dependencies are lightweight objects with a stable ID and a `read(state)` function. Blocks store one combined fingerprint, not copies of metadata values.

## Built-in dependency helpers

`deps.metadata(path)` reads a structured metadata field, including nested custom paths such as `custom.editor`.

`deps.citedKeys()` reads a stable fingerprint of the unique cited-key set. The bibliography dependency uses it so changing citations refreshes the reference list without attaching a complete citation array to every block.

## Why dependencies are separate from rendering

A render rule answers “how should this block look?” A dependency rule answers “what external document state can make this unchanged block stale?” Keeping them separate lets the diff engine preserve ordinary blocks while updating non-contiguous dependent blocks such as `\maketitle` and the bibliography.
