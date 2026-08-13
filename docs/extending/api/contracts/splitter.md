# Splitter Contract

Splitter settings control block boundaries before rendering. They are backend-neutral registry fields.

## `SplitterConfig`

```ts
interface SplitterConfig {
    maxBlockLines: number;
    maxNoEmergencySplitLines: number;
}
```

`maxBlockLines` is the ordinary emergency-split threshold. `maxNoEmergencySplitLines` gives protected long constructs a larger malformed-input recovery window.

## `SplitterRule`

| `kind` | Meaning |
| --- | --- |
| `ignored-env` | Ignore the environment as an ordinary split boundary |
| `transparent-env` | Let inner structures determine blocks; optionally preserve wrapper text |
| `split-env` | Treat the environment as an explicit block structure |
| `no-emergency-split-env` | Avoid ordinary emergency splitting inside the environment |
| `no-emergency-split-begin-token` | Protect a recognized long brace-group start token |
| `emergency-split-end-env` | Permit recovery after a recognized environment end |

Every rule has a diagnostic `name` and either an `envPattern` or `beginTokenPattern` according to its kind.

Splitter rules describe structure; they do not render content. Add them only when a construct's boundaries cannot be handled correctly by existing rules.

## Related APIs

- [Registry contract](./registry)
- [Extension Model](../../index)
