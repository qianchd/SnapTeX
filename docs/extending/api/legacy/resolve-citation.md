# `renderer.resolveCitation`

Returns the stable first-seen citation number for one bibliography key.

## Signature

```ts
renderer.resolveCitation(key: string): number
```

## Parameters

| Parameter | Description |
| --- | --- |
| `key` | Citation key without braces |

## Returns

A one-based number. The first call for a key appends it to renderer citation state; later calls reuse the same number.

## Call relationships

- **Called by:** citation rendering helpers and custom legacy citation rules.
- **Updates:** the list returned by [`getCitedKeys`](./get-cited-keys).
- **Reset by:** renderer state reset or a full backend reset.

```ts
const number = renderer.resolveCitation('smith2024');
```

Do not call this merely to inspect whether a key was cited: it mutates first-seen citation state.

## See also

- [`getCitedKeys`](./get-cited-keys)
- [`context.resolveCitation`](../ast/context-resolve-citation)
