# Metadata and Dependencies

Metadata extraction and block dependencies answer different questions:

- a metadata extractor asks: **what document-level value is declared in this source?**
- a dependency rule asks: **which unchanged block must rerender when that value changes?**

Both declarations and both registry changes belong in `src/rules.ts`.

## Decide which pieces are required

| Requirement | Add |
| --- | --- |
| Read `\editor{...}` into document state | `MetadataExtractor` |
| Use the value while rendering a block | Read `renderer.metadata` or `context.metadata` in that render rule |
| Hide the declaration from ordinary body output | Return its source `range` from the extractor |
| Refresh an unchanged `\maketitle` after the editor changes | `BlockDependencyRule` for that block |

Extraction does not render HTML, and a dependency rule does not extract metadata. Keeping those responsibilities separate lets the same metadata serve more than one renderer without rescanning every block.

## Example goal

Suppose a template declares an editor:

```latex
\editor{Example Editor}
```

You want SnapTeX to store the value at `metadata.custom.editor`, hide the declaration from body output, show it in `\maketitle`, and rerender an existing `\maketitle` block when the value changes.

The repository already includes this complete example as `EDITOR_METADATA_EXTRACTOR` plus the built-in maketitle dependency.

## 1. Define the extractor

`readMetadataCommand` is already imported from `./metadata` in the current file. Add this declaration in `src/rules.ts`:

```ts
export const EDITOR_METADATA_EXTRACTOR = {
    name: 'editor-example',
    extract: source => {
        const editor = readMetadataCommand(source, 'editor');
        return editor
            ? {
                custom: { editor: editor.content },
                ranges: [editor.range]
            }
            : {};
    }
};
```

SnapTeX supplies `source` to `extract`. `readMetadataCommand` searches that source for the first balanced `\editor{...}` call and returns:

```ts
{
    content: 'Example Editor',
    range: { start: 120, end: 143 }
}
```

The offsets are illustrative. Returning `ranges` tells the document model to blank the declaration from ordinary body rendering while preserving its newline structure for source mapping.

```text
document source -> extract(source) -> custom.editor + hidden range
                                   -> LatexDocument metadata/body
```

Custom scalar values belong under `custom`. Built-in title-page fields such as `title`, `date`, `authors`, `affiliations`, and `keywords` already have structured fields on `PreambleData`.

## 2. Register the extractor

```ts
export const SNAP_TEX_RULES = defineRuleRegistry({
    metadataExtractors: [
        BUILTIN_METADATA_EXTRACTOR,
        EDITOR_METADATA_EXTRACTOR
    ],
    renderRules: DEFAULT_RENDER_RULES,
    astRenderRules: DEFAULT_AST_RENDER_RULES,
    blockDependencyRules: DEFAULT_BLOCK_DEPENDENCY_RULES,
    splitterConfig: DEFAULT_SPLITTER_CONFIG,
    splitterRules: DEFAULT_SPLITTER_RULES
});
```

Extractors run in array order. Later non-empty scalar/custom values overwrite earlier values with the same field name; author, affiliation, and keyword arrays are replaced only when an extractor returns a non-empty array.

## 3. Read metadata while rendering

A legacy rule receives metadata through `renderer.metadata`:

```ts
const editor = renderer.metadata?.custom.editor ?? '';
```

An AST rule receives the same structured value through `context.metadata`:

```ts
const editor = context.metadata?.custom.editor ?? '';
```

Rendering access alone does not make an unchanged block refresh when the value changes. That is the dependency rule's job.

The renderer supplies `renderer` or `context`; your extractor does not pass values directly to a render rule. Both rendering paths read the merged `document.metadata` created by `LatexDocument`.

## 4. Declare external invalidation

The built-in `\maketitle` dependency follows this pattern:

```ts
const MAKETITLE_DEPENDENCY = defineBlockDependencyRule({
    name: 'maketitle',
    collect: ({ text, artifact, deps }) => {
        const hasMaketitle = artifact
            ? artifact.metadata.macros.includes('maketitle')
            : text.includes('\\maketitle');

        return hasMaketitle
            ? [
                deps.metadata('title'),
                deps.metadata('custom.editor')
            ]
            : [];
    }
});
```

SnapTeX supplies the `collect` input:

| Member | Meaning |
| --- | --- |
| `text` | Current source for this block. |
| `index` | Current block index. |
| `artifact` | Optional stored AST artifact; it is absent when one has not been produced. |
| `deps` | Factory for supported dependency descriptors. |

The collector identifies whether this block owns `\maketitle`. When it does, the returned descriptors say which document state affects the output.

```text
new/changed block -> collect -> store metadata paths
later metadata edit -> read current paths -> changed fingerprint -> rerender block
```

Register the declaration in `blockDependencyRules`. There is one backend-neutral dependency list; do not duplicate it for legacy and AST rendering.

## How dependency reuse works

SnapTeX does not copy metadata into every block and does not rerun all collectors for every unchanged block.

1. A new or source-changed block runs the dependency collectors.
2. The renderer stores that block's small list of descriptors.
3. On later updates, an unchanged block reuses the list.
4. SnapTeX reads the current values, combines their IDs and values into a fingerprint, and compares it with the previous fingerprint.
5. A changed fingerprint marks the block dirty even though its source hash is unchanged.

This is how non-contiguous blocks such as `\maketitle` and a bibliography can update without forcing a full document render.

## Dependency helpers

### `deps.metadata(path)`

Creates a descriptor for one metadata path:

```ts
deps.metadata('title')
deps.metadata('authors')
deps.metadata('custom.editor')
```

Nested fields use dot-separated paths. The renderer serializes arrays and objects with `JSON.stringify` before hashing.

### `deps.citedKeys()`

Creates a descriptor for the stable cited-key set fingerprint. The bibliography rule uses it so adding or removing citations refreshes the reference list.

The helper does not attach a copy of every key to the block. Citation keys are deduplicated and sorted for this dependency fingerprint because the rendered bibliography order is author-based rather than citation-order based.

## When not to add a dependency

Do not add one when output depends only on the block's own source. A source edit changes the block hash and already triggers rendering.

Use a dependency when all three statements are true:

1. the block source can remain byte-for-byte unchanged;
2. document-level state can change;
3. that state changes this block's HTML.

## Test the complete lifecycle

A useful test renders `\editor{First}\maketitle`, then changes only the metadata declaration to `\editor{Second}`. It should verify that the unchanged maketitle block appears in the update's dirty blocks and that its new HTML contains `Second`.

That behavior test covers extraction, registration, dependency collection, fingerprinting, and rerendering. A test that merely checks the extractor object's name does not.
