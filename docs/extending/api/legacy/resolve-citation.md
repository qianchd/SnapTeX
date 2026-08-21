# `renderer.resolveCitation`

<!--@include: ../../../.vitepress/partials/api-context.md-->

Returns the stable first-seen citation number for one bibliography key. It mutates citation state; use it while rendering a citation, not to test whether a key exists.

## Signature

```ts
renderer.resolveCitation(key: string): number
```

## Parameters

| Parameter | Description |
| --- | --- |
| `key` | Citation key without braces |

## Returns

A one-based number. The first call registers the key and assigns the next number; later calls reuse that number without adding a duplicate.

## Call relationships

- **Called by:** citation rendering helpers and custom legacy citation rules.
- **Updates:** renderer citation state observed by later [`getCitedKeys`](./get-cited-keys) calls.
- **Reset by:** renderer state reset or a full backend reset.

```ts
const number = renderer.resolveCitation('smith2024');
```

Do not call this merely to inspect whether a key was cited: it mutates first-seen citation state.

## See also

- [`getCitedKeys`](./get-cited-keys)
- [`context.resolveCitation`](../ast/context-resolve-citation)
