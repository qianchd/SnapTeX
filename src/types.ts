export interface BibEntry {
    key: string;
    type: string;
    fields: Record<string, string>;
}

export interface SourceLocation {
    file: string;
    line: number;
}

export interface TextRange {
    start: number;
    end: number;
}

export interface AuthorMetadata {
    name: string;
    emails: string[];
    affiliationIds: string[];
}

export interface AffiliationMetadata {
    id: string;
    text: string;
}

export interface PreambleData {
    macros: Record<string, string>;
    tikzGlobal: string;
    tikzMacroMap: Map<string, string>;
    title?: string;
    date?: string;
    authors: AuthorMetadata[];
    affiliations: AffiliationMetadata[];
    keywords: string[];
    custom: Record<string, string>;
}

export type PreambleMetadata = Omit<PreambleData, 'macros' | 'tikzGlobal' | 'tikzMacroMap'>;

export interface MetadataResult {
    data: PreambleData;
    cleanedText: string;
}

export interface UriLike {
    toString(): string;
}

/**
 * Source-backed span for one preview block. Renderers should keep spans and
 * hashes instead of long-lived duplicated block strings.
 */
export interface BlockTextSpan {
    start: number;
    end: number;
    line: number;
    lineCount: number;
}

/**
 * Snapshot retained by the renderer for lazy block rendering after the parsed
 * document releases its transient body text.
 */
export interface BlockTextSnapshot {
    bodyText: string;
    blockSpans: BlockTextSpan[];
}

/**
 * Stable document port consumed by SmartRenderer.
 *
 * LatexDocument implements this view today; future parsers or incremental
 * document stores should satisfy this interface instead of coupling renderer
 * code to a concrete document class.
 */
export interface RenderDocumentView {
    metadata: PreambleData;
    bibEntries: Map<string, BibEntry>;
    rootDir?: UriLike;
    filePool: readonly string[];
    blockSpans: readonly BlockTextSpan[];
    contentStartLineOffset: number;

    getBlockCount(): number;
    getBlockText(index: number): string | undefined;
    getBlockHash(index: number): string | undefined;
    createTextSnapshot(): BlockTextSnapshot;
    getFlattenedLine(targetUriString: string, originalLine: number): number;
    getOriginalPosition(flatLine: number): SourceLocation | undefined;
}

export interface RenderOptions {
    deferFullHtml?: boolean;
}

export interface RenderedBlockMeta {
    index: number;
    hash: string;
    line: number;
    lineCount: number;
    anchors: string[];
}

export interface BlockNumberingCounts {
    eq: string[];
    fig: string[];
    tbl: string[];
    alg: string[];
    sec: string[];
    thm: string[];
}

export interface NumberingPayload {
    blocks: { [index: number]: BlockNumberingCounts };
    labels: Record<string, string>;
}

type FullPayloadBody =
    | {
        htmls: string[];
        blocks?: never;
        preserveUnchangedBlocks: boolean;
    }
    | {
        htmls?: never;
        blocks: RenderedBlockMeta[];
        preserveUnchangedBlocks?: never;
    };

export type RenderPayload =
    | ({
        type: 'full';
        start?: never;
        deleteCount?: never;
        shift?: never;
        dirtyBlocks?: never;
        numbering: NumberingPayload;
    } & FullPayloadBody)
    | {
        type: 'patch';
        start: number;
        deleteCount: number;
        htmls: string[];
        blocks?: never;
        shift: number;
        preserveUnchangedBlocks?: never;
        numbering: NumberingPayload;

        /**
         * Blocks that must be refreshed even though their source hash did not change.
         */
        dirtyBlocks?: { [index: number]: string };
    };

export interface RenderContext {
    currentMacros: Record<string, string>;
    metadata?: PreambleData;
    bibEntries: Map<string, BibEntry>;
    protectHtml(namespace: string, html: string): string;
    renderInline(text: string): string;
    resolveCitation(key: string): number;
    getCitedKeys(): readonly string[];
}

export interface PreprocessRule {
    name: string;
    priority: number;
    apply: (text: string, renderer: RenderContext) => string;
}

export interface DependencyState {
    metadata: PreambleData;
    citedKeysFingerprint: string;
}

export interface RenderDependency {
    id: string;
    read(state: DependencyState): string;
}

export interface DependencyHelpers {
    metadata(field: string): RenderDependency;
    citedKeys(): RenderDependency;
}

export interface BlockDependencyInput {
    text: string;
    index: number;
    deps: DependencyHelpers;
}

export interface BlockDependencyRule {
    name: string;
    collect(input: BlockDependencyInput): RenderDependency[];
}

export type MetadataExtractionResult = Partial<PreambleMetadata> & {
    ranges?: TextRange[];
};

export interface MetadataExtractor {
    name: string;
    extract(text: string): MetadataExtractionResult;
}

export interface RuleRegistry {
    readonly metadataExtractors: readonly MetadataExtractor[];
    readonly renderRules: readonly PreprocessRule[];
    readonly blockDependencyRules: readonly BlockDependencyRule[];
}
