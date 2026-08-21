# `BlockDependencyRule`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Declares document-level values that affect one block's rendered output. You implement this callback; `SmartRenderer` calls it for a new or source-changed block and stores the returned descriptors.

## Signature

```ts
type BlockDependencyRule = (input: BlockDependencyInput) => RenderDependency[]
```

```ts
interface BlockDependencyInput {
    text: string;
    index: number;
    artifact?: AstBlockArtifact;
    deps: DependencyHelpers;
}
```

## Returns

A small list of dependency descriptors, or `[]` when the rule does not apply to the block.

The descriptors identify state to read later; they do not copy current metadata or citation lists into the block snapshot.

## Call relationships

- **Called by:** `SmartRenderer` for newly inserted or source-changed blocks.
- **All registered collectors run:** their returned descriptors are concatenated.
- **Descriptors later call:** their internal `read(state)` functions to build a stable fingerprint.
- **Unchanged blocks:** reuse the stored descriptor list instead of running `collect` again.

```text
new/changed block -> rule(input) -> stored descriptors
later update      -> read current descriptor values -> fingerprint -> dirty or unchanged
```

```ts
const MAKETITLE_DEPENDENCY = defineBlockDependencyRule(({ text, artifact, deps }) => {
    const hasMaketitle = artifact
        ? artifact.metadata.macros.includes('maketitle')
        : text.includes('\\maketitle');
    return hasMaketitle ? [deps.metadata('title')] : [];
});
```

The optional `artifact` may be absent before AST warm-up. A backend-neutral collector must preserve a source-text detection path when it needs to work immediately.

## See also

- [`defineBlockDependencyRule`](../registry/define-block-dependency-rule)
- [`deps.metadata`](./metadata)
- [`deps.citedKeys`](./cited-keys)
