::: info How to read this API
These are TypeScript APIs compiled into SnapTeX; a `.tex` project cannot load them at runtime.

- `function name(...)` is a helper that your rule imports and calls.
- `apply(...)`, `match(...)`, `render(...)`, `extract(...)`, and `collect(...)` are callbacks that your rule implements and SnapTeX calls.
- `renderer.name(...)`, `context.name(...)`, `input.name(...)`, and `deps.name(...)` are methods SnapTeX supplies to callbacks; do not import or construct them.
- `service.name(...)` is an instance method called after your host or test constructs `PreviewUpdateService`.

Register extension declarations through `SNAP_TEX_RULES` in `src/rules.ts`. See [Source API Scope](/extending/api/scope) for imports, value ownership, output safety, rebuilds, and testing.
:::
