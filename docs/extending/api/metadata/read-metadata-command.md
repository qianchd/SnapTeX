# `readMetadataCommand`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Finds the first balanced one-argument metadata command in source text. Use it inside a metadata extractor for simple `\name{value}` declarations.

## Signature

```ts
function readMetadataCommand(
    text: string,
    commandName: string
): { content: string; range: TextRange } | undefined
```

## Parameters

| Parameter | Description |
| --- | --- |
| `text` | Source supplied to a `MetadataExtractor` |
| `commandName` | Command name without the leading backslash |

## Returns

The content inside the required group and the full command's source range, or `undefined` when no valid command is found.

## Call relationships

- **Called by:** custom `MetadataExtractor.extract` callbacks.
- **Uses:** the shared balanced command reader in `src/utils.ts`.
- **Returned range feeds:** document cleanup that blanks metadata declarations from body rendering.

```ts
const editor = readMetadataCommand(source, 'editor');
return editor
    ? { custom: { editor: editor.content }, ranges: [editor.range] }
    : {};
```

This convenience reader returns only the first occurrence. Use the lower-level [source readers](../source/replace-latex-command-calls) for repeated or multi-argument command syntax.

## See also

- [Metadata and dependency contract](../contracts/metadata-dependencies)
- [Metadata and Dependencies Tutorial](../../metadata)
