# Rule API Reference

This chapter documents the source-level APIs intended for extension declarations in `src/rules.ts`. It explains who creates each callback value, what the function returns, and where the result goes next.

For a complete first rule, begin with the [Rendering Rules Tutorial](./rules.md). For metadata invalidation, see [Metadata and Dependencies](./metadata.md).

::: info API scope
SnapTeX does not publish a separate runtime rules package. The interfaces below are the supported extension surface inside this repository. Add imports, declarations, and registry entries in `src/rules.ts`; do not edit the helper module merely to call one of its exported functions.
:::

## Mental model

An extension uses one of three callback flows.

### Legacy rendering

```text
SmartRenderer
  -> rule.apply(currentBlockText, renderContext)
  -> rule returns transformed text and protected tokens
  -> next rule
  -> Markdown-it
  -> protected HTML is restored
```

### AST rendering

```text
AST walker visits a parsed node
  -> rule.match(astInput)
  -> rule.render(astInput, astContext)
  -> rule returns HTML and consumed sibling count
  -> walker continues after consumed nodes
```

### Metadata and dependencies

```text
LatexDocument
  -> extractor.extract(documentSource)
  -> structured metadata

SmartRenderer
  -> dependency.collect(blockInput)
  -> dependency descriptors
  -> current values are fingerprinted on each update
```

Legacy and AST rendering are independent alternatives. You use the API for the backend you are extending; you do not have to implement the same feature twice.

## API map by task

| Task | Start with |
| --- | --- |
| Add a legacy command | `PreprocessRule` + `replaceLatexCommandCalls` |
| Generate safe legacy HTML | `escapeHtml` + `renderer.protectHtml` |
| Render common inline LaTeX in a raw fragment | `renderInlineLatexHtml` |
| Add an AST command | `defineAstRenderRule` + `readAstCommandArguments` |
| Preserve nested AST syntax | `input.renderChildren` |
| Render generated AST source | `input.renderSource` |
| Read custom metadata | `readMetadataCommand` |
| Refresh unchanged dependent output | `defineBlockDependencyRule` |
| Change block boundaries | `SplitterRule` entries in `splitterRules` |
| Verify the extension end to end | `PreviewUpdateService` |

## Registry functions

### `defineRuleRegistry(registry)`

```ts
defineRuleRegistry(registry: RuleRegistry): RuleRegistry
```

**Caller:** `src/rules.ts`, once when constructing `SNAP_TEX_RULES`.

**Input:** one object containing all extension arrays and splitter configuration.

**Return:** a new registry object. Each array is copied. `renderRules` is sorted by ascending `priority`; `astRenderRules` keeps its declared array order.

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

All fields are required so the active document and renderer receive one coherent configuration:

| Field | Element type | Consumer |
| --- | --- | --- |
| `metadataExtractors` | `MetadataExtractor` | `LatexDocument` metadata pass |
| `renderRules` | `PreprocessRule` | legacy block renderer |
| `astRenderRules` | `AstRenderRule` | AST block renderer |
| `blockDependencyRules` | `BlockDependencyRule` | incremental dirty-block logic |
| `splitterConfig` | `SplitterConfig` | block splitter |
| `splitterRules` | `SplitterRule` | legacy and AST-aware splitting |

Do not mutate the arrays after constructing the registry. Rule changes are source changes and require a rebuild/reload.

### `defineAstRenderRule(rule)`

```ts
defineAstRenderRule(rule: AstRenderRule): AstRenderRule
```

**Caller:** `src/rules.ts` when declaring an AST rule.

**Behavior:** returns the supplied object unchanged. Its value is TypeScript contextual checking and a recognizable declaration style.

```ts
const AST_BADGE_RULE = defineAstRenderRule({
    name: 'ast-badge',
    match: input => input.node.type === 'macro' && input.node.content === 'badge',
    render: () => ({ html: '<span>Badge</span>' })
});
```

### `defineBlockDependencyRule(rule)`

```ts
defineBlockDependencyRule(rule: BlockDependencyRule): BlockDependencyRule
```

Like `defineAstRenderRule`, this returns its argument unchanged and provides contextual type checking.

Use it only when an unchanged block depends on state outside its own source:

```ts
const COVER_DEPENDENCY = defineBlockDependencyRule({
    name: 'cover',
    collect: ({ text, deps }) => text.includes('\\makecover')
        ? [deps.metadata('title')]
        : []
});
```

## Legacy rendering API

### `PreprocessRule`

```ts
interface PreprocessRule {
    name: string;
    priority: number;
    apply(text: string, renderer: RenderContext): string;
}
```

**Caller:** `SmartRenderer`.

**Arguments supplied by SnapTeX:**

- `text` is the current block after all lower-priority rules have transformed it;
- `renderer` is the `RenderContext` for the active document and protection lifecycle.

**Return:** the text passed to the next rule. After the final rule, SnapTeX runs Markdown-it and restores protected HTML.

```ts
const REMOVE_COMMAND_RULE: PreprocessRule = {
    name: 'remove-draft-marker',
    priority: 200,
    apply: text => text.replace(/\\draftmarker\b/g, '')
};
```

`name` is diagnostic only; it does not match source. `priority` controls order and has no meaning in AST rendering.

### `RenderContext`

SnapTeX creates this object and supplies it as the second `apply` argument. A rule does not construct it.

| Member | Type | Use |
| --- | --- | --- |
| `currentMacros` | `Record<string, string>` | Current KaTeX macro definitions |
| `metadata` | `PreambleData \| undefined` | Title-page and custom metadata |
| `bibEntries` | `Map<string, BibEntry>` | Parsed bibliography entries by key |
| `protectHtml(...)` | function | Hide trusted generated HTML until Markdown completes |
| `renderInline(text)` | function | Render a Markdown fragment inline |
| `resolveCitation(key)` | function | Get/create a stable one-based citation number |
| `getCitedKeys()` | function | Read citation keys collected for the document |

#### `renderer.protectHtml(namespace, html, mode?)`

```ts
renderer.protectHtml(
    namespace: string,
    html: string,
    mode: 'inline' | 'block' = 'block'
): string
```

**Input:** trusted HTML generated by your rule.

**Return:** a temporary token such as `XSNAP:badge:12Y`, not the HTML itself.

Return or embed that token in the transformed block. Markdown sees only the token; SnapTeX restores the stored HTML afterward, including nested protected tokens.

```ts
const safeText = escapeHtml(call.requiredArgs[0].content);
return renderer.protectHtml(
    'badge',
    `<span class="latex-badge">${safeText}</span>`,
    'inline'
);
```

- `namespace` helps identify/debug the token and must contain only letters, numbers, `_`, or `-`.
- `html` must not contain unescaped user-controlled source.
- use `'inline'` for `span`, `a`, `sup`, or content living in a paragraph;
- use `'block'` for standalone `div`, `table`, `aside`, and similar structures.

The mode affects how a token wrapped by Markdown in `<p>...</p>` is restored. It does not apply CSS and does not invoke another rule.

#### `renderer.renderInline(text)`

```ts
renderer.renderInline(markdown: string): string
```

Runs Markdown-it's inline renderer without running the complete LaTeX rule pipeline. It is useful when a rule has already converted LaTeX-specific structures and wants Markdown emphasis/link handling.

It is **not** a general LaTeX renderer and does not automatically read balanced commands or render KaTeX math.

#### `renderer.resolveCitation(key)`

```ts
renderer.resolveCitation(key: string): number
```

Returns the stable one-based number for a citation key in the current renderer lifecycle. The first unknown key is appended to the internal cited-key list; repeated calls for the same key return the same number.

Use the higher-level built-in citation renderer when possible. This low-level member is useful only for a custom citation presentation.

#### `renderer.getCitedKeys()`

```ts
renderer.getCitedKeys(): readonly string[]
```

Returns the keys currently collected by the document render. Treat the array as read-only. Bibliography rendering uses it to select entries; dependency logic uses a separate deduplicated/sorted fingerprint.

## Balanced source readers

These functions read source structure without assigning rendering semantics. Prefer them over a new command-specific brace regex.

### `replaceLatexCommandCalls(text, ruleOrRules)`

```ts
replaceLatexCommandCalls(
    text: string,
    rule: {
        name: string | readonly string[];
        requiredArgs?: number;
        optionalArgs?: number;
        allowStar?: boolean;
        render(call: LatexCommandCall): string;
    } | Array<...>
): string
```

**Caller:** usually a legacy rule's `apply` function.

**Input:** the current block plus one or more command descriptions.

**Callback:** SnapTeX calls `render(call)` for every valid command it finds.

**Return:** a new string with valid calls replaced and all other source preserved.

Example source:

```latex
Before \badge[compact]{A {nested} value} after.
```

Rule:

```ts
replaceLatexCommandCalls(text, {
    name: 'badge',
    optionalArgs: 1,
    requiredArgs: 1,
    render: call => {
        const mode = call.optionalArgs[0]?.content ?? 'normal';
        const value = call.requiredArgs[0].content;
        return `${mode}: ${value}`;
    }
});
```

The `call` object contains:

| Field | Meaning |
| --- | --- |
| `name` | Matched command name without `\` |
| `star` | Whether an allowed `*` followed the command |
| `optionalArgs` | Balanced `[...]` groups that were present |
| `requiredArgs` | Required `{...}` groups; all required groups must be present |
| `start` | Offset of `\` in `text` |
| `commandEnd` | Offset after command name and optional star |
| `end` | Offset immediately after the final consumed argument |

Each argument group contains `content`, `start`, `end`, `open`, and `close`. `content` excludes delimiters; offsets refer to the `text` string passed into the function.

If required arguments are absent or unbalanced, that occurrence remains unchanged. Optional arguments may be absent even when `optionalArgs` is nonzero.

### `readLatexGroup(text, startIndex, options?)`

```ts
readLatexGroup(
    text: string,
    startIndex: number,
    options?: {
        delimiter?: 'brace' | 'bracket';
        skipWhitespace?: boolean;
    }
): LatexGroup | undefined
```

Reads one balanced group at or after `startIndex`.

- default delimiter is `{...}`;
- default `skipWhitespace` is `true`;
- whitespace and TeX line comments before the group are skipped by default;
- escaped delimiter characters do not change nesting depth;
- `undefined` means the expected opener or balanced closer was not found.

```ts
const group = readLatexGroup(source, commandEnd);
if (group) {
    console.log(group.content, group.start, group.end);
}
```

Use this lower-level reader when you need offsets or when you are not performing a search-and-replace. Most command render rules should use `replaceLatexCommandCalls` instead.

### `readLatexCommandAt(text, startIndex, options)`

```ts
readLatexCommandAt(text, startIndex, {
    name: string;
    requiredArgs?: number;
    optionalArgs?: number;
    allowStar?: boolean;
    skipWhitespace?: boolean;
}): LatexCommandCall | undefined
```

Attempts to read one named command at a known position. By default it first skips whitespace/comments, so `call.start` can be later than the supplied `startIndex`.

This function does not search the entire string. Use it when another scanner already found the candidate position or when parsing a command that must occur immediately after another structure.

It rejects a longer control word prefix: asking for `section` does not match `sectional`.

### `skipLatexWhitespace(text, index)`

```ts
skipLatexWhitespace(text: string, index: number): number
```

Advances over whitespace and complete TeX line comments. It returns the first index that could begin a structural token, or `text.length` at the end.

Callers that need to preserve skipped source can use `text.slice(originalIndex, returnedIndex)`.

### `stripLatexComments(text, options?)`

```ts
stripLatexComments(
    text: string,
    options?: { mode?: 'remove' | 'mask' }
): string
```

- `remove` (default) removes comments for display-oriented processing;
- `mask` replaces each unescaped line comment with `%`, preserving line count and TeX's line-ending suppression semantics for source-stable scans.

Ordinary render extensions normally should not call this function: comment cleanup already runs at the appropriate document/rule stage. Use it only when implementing a new source-level scanner that explicitly needs one of these two semantics.

## Safe output and inline rendering

### `escapeHtml(text)`

```ts
escapeHtml(text: string): string
```

Escapes `&`, `<`, `>`, double quotes, and single quotes. Use it whenever source text is inserted as plain content into generated HTML.

```ts
const safeName = escapeHtml(call.requiredArgs[0].content);
const html = `<span>${safeName}</span>`;
```

`escapeHtml` does not render LaTeX and does not mark the result as trusted. In a legacy rule, generated HTML still needs `protectHtml`.

### `renderMath(tex, displayMode, renderer)`

```ts
renderMath(
    tex: string,
    displayMode: boolean,
    renderer: RenderContext
): string
```

Renders one math body with KaTeX and `renderer.currentMacros`.

- `tex` excludes `$`, `\(`, `\[`, or environment delimiters;
- `false` requests inline math;
- `true` requests display math;
- `renderer` is the `RenderContext` supplied to the legacy rule.

The return value is a protected token containing KaTeX HTML. It can safely be embedded in later legacy transformed text.

```ts
const mathToken = renderMath('p > n', false, renderer);
```

### `renderInlineLatexHtml(text, renderMathHtml)`

```ts
renderInlineLatexHtml(
    text: string | undefined,
    renderMathHtml: (mathSource: string) => string
): string
```

This specialized helper converts a raw inline fragment into HTML. It handles common inline text transformations/styles, `\\` line breaks, `\and`, removed footnotes, nonbreaking spaces, and `$...$` math.

The second argument is a callback because the helper does not own a renderer or macro table.

Expanded example:

```ts
const argumentSource = call.requiredArgs[0].content;

const renderInlineMath = (mathSource: string): string => {
    return renderMath(mathSource, false, renderer);
};

const contentHtml = renderInlineLatexHtml(
    argumentSource,
    renderInlineMath
);
```

Where does `mathSource` come from?

1. Your code passes the function `renderInlineMath` as the second argument.
2. `renderInlineLatexHtml` scans `argumentSource`.
3. When it encounters `$p > n$`, it removes the dollar delimiters.
4. It invokes your callback as `renderInlineMath('p > n')`.
5. Your callback passes that value to `renderMath`.
6. The returned KaTeX token/HTML is inserted into `contentHtml`.

The shorter form is identical:

```ts
const contentHtml = renderInlineLatexHtml(
    argumentSource,
    mathSource => renderMath(mathSource, false, renderer)
);
```

`mathSource` is an ordinary parameter name chosen by the developer. It is not a global variable or a value that must be declared elsewhere.

The function returns HTML, not a legacy protection token. When a legacy rule places the result into a larger generated element, protect that outer element:

```ts
return renderer.protectHtml(
    'custom-inline',
    `<span>${contentHtml}</span>`,
    'inline'
);
```

Do not use this helper for a complete block or arbitrary nested environments. In AST mode, prefer rendering parsed children.

## AST rendering API

### `AstRenderRule`

```ts
interface AstRenderRule {
    name: string;
    match(input: AstRenderInput): boolean;
    render(
        input: AstRenderInput,
        context: AstRenderContext
    ): AstRenderResult | undefined;
}
```

**Caller:** the AST walker.

For each node, SnapTeX checks rules in registry array order. `match` should be a cheap structural ownership check. If it returns `true`, `render` may:

- return `{ html, consumedNodes? }` to claim the node;
- return `undefined` to let later matching rules try it.

`html` is final HTML and does not pass through Markdown. `consumedNodes` defaults to `1`.

### `AstRenderInput`

SnapTeX creates one input for the current node:

| Member | Meaning |
| --- | --- |
| `node` | Current parsed node |
| `siblings` | All nodes in the same parent container |
| `index` | Current node's index in `siblings` |
| `renderChildren(nodes)` | Render existing parsed child nodes with active AST rules |
| `renderSource(source)` | Parse and render generated LaTeX source with active AST rules |

#### `input.renderChildren(nodes)`

Use this when a command/environment exposes parsed child nodes:

```ts
const argument = readRequiredMacroArgument(input.node);
if (!argument) {
    return undefined;
}

return {
    html: `<span>${input.renderChildren(argument.content)}</span>`
};
```

This preserves nested math, citations, styles, and other AST rules without reparsing source.

#### `input.renderSource(source)`

Use this for generated source that does not already have child nodes, such as an expanded user macro:

```ts
return { html: input.renderSource(expandedSource) };
```

SnapTeX parses the generated fragment with a bounded recursion depth. Prefer `renderChildren` whenever parsed nodes already exist.

### `readAstCommandArguments(input, requiredArgCount?)`

```ts
readAstCommandArguments(
    input: AstRenderInput,
    requiredArgCount = 1
): {
    requiredArgs: string[];
    optionalArgs: string[];
    consumedNodes: number;
}
```

Unknown macros do not always receive attached argument nodes from the parser. This function handles both forms:

- arguments attached to the macro node;
- optional bracket nodes and required group siblings that immediately follow it.

`requiredArgCount` tells the detached-group reader how many required arguments belong to the command. The result contains source text without delimiters.

```ts
const args = readAstCommandArguments(input, 2);
if (args.requiredArgs.length < 2) {
    return undefined;
}

return {
    html: context.escapeHtml(args.requiredArgs.join(' / ')),
    consumedNodes: args.consumedNodes
};
```

Always preserve `args.consumedNodes`; otherwise detached group nodes will be rendered a second time.

### AST node guards and readers

These helpers are defined in `src/ast/visit-utils.ts`. Import them at the top of `src/rules.ts` when a custom AST rule needs parsed children rather than flattened argument strings.

#### `isMacroNode(node, name?)`

```ts
isMacroNode(node: unknown, name?: string): node is SnaptexAstMacro
```

Checks the node type and, when supplied, the exact macro name without a leading `\`.

```ts
match: input => isMacroNode(input.node, 'badge')
```

#### `isEnvironmentNode(node, name?)`

```ts
isEnvironmentNode(node: unknown, name?: string): node is SnaptexAstEnvironment
```

Checks `environment` and `mathenv` nodes and optionally their exact environment name.

#### `environmentName(node)`

```ts
environmentName(node: unknown): string | undefined
```

Normalizes the parser's possible environment-name shapes to one string.

#### `readRequiredMacroArgument(node, index?)`

```ts
readRequiredMacroArgument(
    node: SnaptexAstMacro,
    index = 0
): SnaptexAstArgument | undefined
```

Returns an attached `{...}` argument object whose `content` is an array of parsed child nodes. It does not read detached siblings; use `readAstCommandArguments` for that case.

#### `readOptionalMacroArgument(node, index?)`

The optional `[...]` counterpart to `readRequiredMacroArgument`.

#### `argumentText(argument)`

```ts
argumentText(argument: SnaptexAstArgument | undefined): string
```

Flattens one parsed argument to readable text. This discards nested rendering structure; use `input.renderChildren(argument.content)` when nested syntax should remain active.

### `AstRenderContext`

SnapTeX creates this object and passes it as the second `render` argument.

| Member | Purpose |
| --- | --- |
| `currentMacros` | Current math macro definitions |
| `metadata` | Structured document metadata |
| `bibEntries` | Parsed bibliography entries by key |
| `escapeHtml(text)` | Escape plain source text |
| `sourceSlice(node)` | Recover exact source for one positioned node |
| `sourceContent(nodes)` | Recover source spanning a positioned node sequence |
| `renderMath(tex, displayMode)` | Render KaTeX with current macros |
| `renderLabel(label)` | Create the hidden reference/sync anchor |
| `renderRef(labels, type)` | Render `ref` or `eqref` links |
| `resolveCitation(key)` | Resolve a stable citation number |
| `renderCitation(command, keys, options)` | Render a supported citation form |
| `getCitedKeys()` | Read collected citation keys |
| `renderImage(path, options?)` | Create preview image/PDF placeholder HTML |

#### `context.escapeHtml(text)`

The AST-context form of `escapeHtml`. Use it for plain text returned directly as HTML.

#### `context.sourceSlice(node)` and `context.sourceContent(nodes)`

Use these when a rule must preserve exact source punctuation or spacing. They prefer parser source positions and fall back to AST-to-text conversion when positions are unavailable.

#### `context.renderMath(tex, displayMode)`

Returns KaTeX HTML directly. Unlike legacy `renderMath`, no protection token is needed because AST output bypasses Markdown.

#### `context.renderLabel(label)` / `context.renderRef(labels, type)`

Use these shared services instead of constructing custom anchor IDs. `type` is `'ref'` or `'eqref'`; `labels` permits comma-separated reference lists that have already been split.

#### `context.renderCitation(command, keys, options)`

```ts
context.renderCitation(
    command: string,
    keys: readonly string[],
    options: { pre?: string; post?: string }
): string
```

Delegates to the shared citation renderer. `command` is the citation family name without `\`; `keys` are already split citation keys. Optional `pre` and `post` represent citation notes.

#### `context.renderImage(path, options?)`

Creates the same preview placeholder used for `\includegraphics`: a local-image marker for raster images or a PDF canvas for PDF paths. The webview/standalone host resolves that marker later. `path` is project-relative. `options` is available to contexts that preserve the original `\includegraphics[...]` option string; the production renderer currently ignores that string.

## Metadata API

### `MetadataExtractor`

```ts
interface MetadataExtractor {
    name: string;
    extract(text: string): MetadataExtractionResult;
}
```

`LatexDocument` calls each extractor with comment-masked document source before body slicing. The return value may provide built-in metadata fields, `custom` values, and source `ranges` to blank from body rendering.

### `readMetadataCommand(text, commandName)`

```ts
readMetadataCommand(
    text: string,
    commandName: string
): {
    content: string;
    range: { start: number; end: number };
} | undefined
```

Finds the first balanced one-argument metadata command. `commandName` excludes `\`.

```ts
const advisor = readMetadataCommand(source, 'advisor');
return advisor
    ? { custom: { advisor: advisor.content }, ranges: [advisor.range] }
    : {};
```

Return the range when the declaration should disappear from normal body output. Omitting it stores the value but leaves the source visible to later splitting/rendering.

## Dependency API

### `BlockDependencyRule.collect(input)`

```ts
interface BlockDependencyRule {
    name: string;
    collect(input: {
        text: string;
        index: number;
        artifact?: AstBlockArtifact;
        deps: DependencyHelpers;
    }): RenderDependency[];
}
```

SnapTeX runs collectors for new/source-changed blocks and reuses the resulting descriptor list for unchanged blocks.

### `deps.metadata(path)`

```ts
deps.metadata(path: string): RenderDependency
```

Creates a descriptor with ID `metadata:${path}`. Dot-separated paths read nested values such as `custom.editor`. Missing values become an empty string; non-string values are JSON-serialized before fingerprinting.

### `deps.citedKeys()`

```ts
deps.citedKeys(): RenderDependency
```

Creates the `citations:list` descriptor backed by a hash of unique, sorted citation keys. This avoids copying the full list into every bibliography block and ignores source-order changes that cannot affect the author-sorted bibliography.

## Splitter API

### `SplitterConfig`

```ts
interface SplitterConfig {
    maxBlockLines: number;
    maxNoEmergencySplitLines: number;
}
```

- `maxBlockLines` is the normal line threshold after which malformed/open structure may trigger recovery splitting;
- `maxNoEmergencySplitLines` is the larger budget granted to explicitly protected long structures before recovery resumes.

These are structural safety limits, not visual page sizes.

### `SplitterRule`

Add entries to `splitterRules` in `src/rules.ts`:

| `kind` | Effect |
| --- | --- |
| `ignored-env` | Environment markers do not participate in the legacy environment stack |
| `transparent-env` | AST refinement can split inside the environment; `preserveWrapper` keeps wrappers where required |
| `split-env` | The environment is a preferred structural block boundary |
| `no-emergency-split-env` | Resist emergency splitting while inside the environment, up to the larger budget |
| `no-emergency-split-begin-token` | Resist emergency splitting when the current buffer contains the matching opener |
| `emergency-split-end-env` | Permit a recovery boundary after this environment ends in a trapped block |

Every rule has a diagnostic `name`. Environment rules use `envPattern`; begin-token rules use `beginTokenPattern`. Reset `RegExp.lastIndex` if you call a stateful global/sticky regex yourself; SnapTeX's splitter matcher already does this internally.

Change splitter rules only for structural ownership. Rendering syntax still belongs in `renderRules` or `astRenderRules`.

## End-to-end test API

### `new PreviewUpdateService(fileProvider, registry?)`

```ts
const service = new PreviewUpdateService(
    new MemoryFileProvider(),
    SNAP_TEX_RULES
);
```

The service exercises document parsing, metadata, splitting, scanning, dependencies, the selected renderer, and payload generation. It is a better extension test boundary than calling one regex/helper alone.

### `service.render(uri, source, options)`

```ts
const payload = await service.render(uri, source, {
    backendMode: 'legacy',
    deferFullHtml: false
});
```

- `backendMode` chooses the one rendering path under test;
- `deferFullHtml: false` returns eager `htmls`, convenient for assertions;
- `deferFullHtml: true` returns block metadata and exercises lazy rendering.

For a deferred payload, request a block with:

```ts
const block = await service.renderBlockByIndex(0);
const html = block?.html ?? '';
```

Assert output and update behavior: generated elements, visible text, absent leaked commands, dirty dependent blocks, labels, or source mapping. Do not assert merely that a rule name exists in source.

## Definition locations

All custom extension edits still belong in `src/rules.ts`. The table below tells you where imported contracts are implemented, not where to scatter custom behavior.

| API | Definition module |
| --- | --- |
| Registry, legacy render, metadata, dependency, splitter types | `src/types.ts` |
| `escapeHtml`, command/group readers, `replaceLatexCommandCalls` | `src/utils.ts` |
| `renderMath`, `renderInlineLatexHtml` | `src/rule-helpers.ts` |
| Registry constructors and active `SNAP_TEX_RULES` | `src/rules.ts` |
| `readMetadataCommand` and built-in extractor | `src/metadata.ts` |
| AST rule/context and `readAstCommandArguments` | `src/ast/rules/index.ts` |
| AST node guards and attached-argument readers | `src/ast/visit-utils.ts` |
| End-to-end rendering service | `src/preview-update-service.ts` |

When a helper is already imported by `src/rules.ts`, reuse it. Otherwise add one import at the top of `src/rules.ts`; do not copy the helper or modify its module solely to expose the custom rule.
