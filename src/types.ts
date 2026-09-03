import type { AstBlockArtifact } from './ast/types';

export interface BibEntry {
    key: string;
    type: string;
    fields: Record<string, string>;
}

export interface SourceLocation {
    file: string;
    line: number;
}

export interface SourceSyncOptions {
    anchors?: readonly string[];
    sourceStart?: number;
    sourceEnd?: number;
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
    colors: Record<string, string>;
    tikzGlobal: string;
    tikzMacroMap: Map<string, string>;
    title?: string;
    date?: string;
    authors: AuthorMetadata[];
    affiliations: AffiliationMetadata[];
    keywords: string[];
    custom: Record<string, string>;
}

export type PreambleMetadata = Omit<PreambleData, 'macros' | 'colors' | 'tikzGlobal' | 'tikzMacroMap'>;

export interface MetadataResult {
    data: PreambleData;
    cleanedText: string;
}

export interface DocumentDiagnostic {
    message: string;
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
    prefix?: string;
    suffix?: string;
}

export type BackendMode = 'legacy' | 'ast(experimental)';
export type PreviewLayoutMode = 'continuous' | 'paged';
export const DEFAULT_PREVIEW_LAYOUT: PreviewLayoutMode = 'paged';

export interface PreviewStyleSettings {
    fontSize: string;
    lineHeight: string;
    contentMaxWidth: string;
    fontFamily: string;
}

export const DEFAULT_PREVIEW_STYLE_SETTINGS: PreviewStyleSettings = {
    fontSize: '2.8cqw',
    lineHeight: '1.25',
    contentMaxWidth: '3000px',
    fontFamily: '"Times New Roman", "Cambria", "Latin Modern Roman", "Georgia", serif'
};

/**
 * Snapshot retained by the renderer for lazy block rendering after the parsed
 * document releases its transient body text.
 */
export interface BlockTextSnapshot {
    bodyText: string;
    blockSpans: readonly BlockTextSpan[];
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
    bibEntries: ReadonlyMap<string, BibEntry>;
    rootDir?: UriLike;
    filePool: readonly string[];
    contentStartLineOffset: number;

    getBlockHash(index: number): string | undefined;
    getAstBlockArtifact(index: number): AstBlockArtifact | undefined;
    setAstBlockArtifact(index: number, artifact: AstBlockArtifact): void;
    createTextSnapshot(): BlockTextSnapshot;
    getFlattenedLine(targetUriString: string, originalLine: number): number;
    getOriginalPosition(flatLine: number): SourceLocation | undefined;
}

export interface RenderOptions {
    deferFullHtml?: boolean;
    resetPreviewState?: boolean;
}

export interface RenderedBlockMeta {
    index: number;
    hash: string;
    line: number;
    lineCount: number;
    anchors?: string[];
}

export interface BlockNumberingCounts {
    eq: string[];
    fig: string[];
    subfig: string[];
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
        resetPreviewState?: boolean;
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
    currentMacros: Readonly<Record<string, string>>;
    metadata?: PreambleData;
    bibEntries: ReadonlyMap<string, BibEntry>;
    protectHtml(namespace: string, html: string, mode?: ProtectedHtmlMode): string;
    renderInline(text: string): string;
    resolveCitation(key: string): number;
    getCitedKeys(): readonly string[];
}

export type ProtectedHtmlMode = 'block' | 'inline';

export interface PreprocessRule {
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
    artifact?: AstBlockArtifact;
    deps: DependencyHelpers;
}

export type BlockDependencyRule = (input: BlockDependencyInput) => RenderDependency[];

export interface SplitterConfig {
    maxBlockLines: number;
    maxNoEmergencySplitLines: number;
}

export type SplitterWrapperContent = 'group-remainder' | { requiredArgument: number };

export type SplitterRule =
    | { name: string; kind: 'ignored-env'; envPattern: RegExp }
    | { name: string; kind: 'transparent-env'; envPattern: RegExp; preserveWrapper?: boolean }
    | { name: string; kind: 'split-env'; envPattern: RegExp }
    | { name: string; kind: 'no-emergency-split-env'; envPattern: RegExp }
    | { name: string; kind: 'context-wrapper'; macroPattern: RegExp; content: SplitterWrapperContent }
    | { name: string; kind: 'emergency-split-end-env'; envPattern: RegExp };

export interface SplitterOptions {
    config: SplitterConfig;
    rules: readonly SplitterRule[];
}

export type MetadataExtractionResult = Partial<PreambleMetadata> & {
    ranges?: TextRange[];
};

export type MetadataExtractor = (text: string) => MetadataExtractionResult;
