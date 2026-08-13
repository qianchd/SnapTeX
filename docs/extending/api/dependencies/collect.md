# `BlockDependencyRule.collect`

Declares document-level values that affect one block's rendered output.

## Signature

```ts
collect(input: BlockDependencyInput): RenderDependency[]
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

## Call relationships

- **Called by:** `SmartRenderer` for newly inserted or source-changed blocks.
- **All registered collectors run:** their returned descriptors are concatenated.
- **Descriptors later call:** their internal `read(state)` functions to build a stable fingerprint.
- **Unchanged blocks:** reuse the stored descriptor list instead of running `collect` again.

```ts
collect: ({ text, artifact, deps }) => {
    const hasMaketitle = artifact
        ? artifact.metadata.macros.includes('maketitle')
        : text.includes('\\maketitle');
    return hasMaketitle ? [deps.metadata('title')] : [];
}
```

The optional `artifact` may be absent before AST warm-up. A backend-neutral collector must preserve a source-text detection path when it needs to work immediately.

## See also

- [`defineBlockDependencyRule`](../registry/define-block-dependency-rule)
- [`deps.metadata`](./metadata)
- [`deps.citedKeys`](./cited-keys)
