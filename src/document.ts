import type { IFileProvider } from './file-provider';
import { extractMetadata } from './metadata';
import { BibTexParser } from './bib';
import { BibEntry, SourceLocation, PreambleData, MetadataResult, BlockTextSnapshot, BlockTextSpan, DocumentDiagnostic, RenderDocumentView, BackendMode, UriLike } from './types';
import { REGEX_STR, R_BIBLIOGRAPHY, R_THEBIBLIOGRAPHY } from './patterns';
import { SNAP_TEX_RULES, type RuleRegistry } from './rules';
import { LatexBlockSplitter } from './splitter';
import { extractAstBlockArtifact } from './ast/block-metadata';
import type { AstBlockArtifact } from './ast/types';
import { splitLatexWithAstIncremental, type AstSplitSnapshot } from './ast/splitter';
import { getBlockSpanText, lineAtOffset, normalizeUri, scanLatexBraceBalance, stableHash, stripLatexComments } from './utils';

export interface DocumentParseResult {
    bodyText: string;
    blockSpans: BlockTextSpan[];
    blockHashes: string[];
    astBlockArtifacts: Array<AstBlockArtifact | undefined>;
    filePool: string[];
    sourceMapSegments: SourceMapSegment[];
    metadata: PreambleData;
    bibEntries: Map<string, BibEntry>;
    diagnostics: DocumentDiagnostic[];
    contentStartLineOffset: number;
}

export interface SourceMapSegment {
    flatStart: number;
    fileIndex: number;
    sourceStart: number;
    length: number;
}

interface BibCacheEntry {
    mtime: number;
    entries: Map<string, BibEntry>;
}

interface FlattenOutput {
    textLines: string[];
    sourceMapSegments: SourceMapSegment[];
}

function appendFlattenedLine(output: FlattenOutput, text: string, fileIndex: number, sourceLine: number): void {
    const flatLine = output.textLines.length;
    const previous = output.sourceMapSegments.at(-1);
    if (previous
        && previous.fileIndex === fileIndex
        && previous.sourceStart + previous.length === sourceLine) {
        previous.length += 1;
    } else {
        output.sourceMapSegments.push({ flatStart: flatLine, fileIndex, sourceStart: sourceLine, length: 1 });
    }
    output.textLines.push(text);
}

interface ParseOptions {
    trace?: (label: string) => void;
    backendMode?: BackendMode;
}

/**
 * Parsed LaTeX document state used by the renderer.
 *
 * LatexDocument flattens the root document and supported subfiles into one body
 * string, stores block spans instead of duplicated block strings, and keeps
 * compact source maps for editor-preview synchronization.
 */
export class LatexDocument<TUri extends UriLike = UriLike> implements RenderDocumentView {
    private bodyText: string = "";
    private blockSpans: BlockTextSpan[] = [];
    private blockHashes: string[] = [];
    private astBlockArtifacts: Array<AstBlockArtifact | undefined> = [];

    public filePool: string[] = [];
    private sourceMapSegments: SourceMapSegment[] = [];

    public contentStartLineOffset: number = 0;
    public diagnostics: DocumentDiagnostic[] = [];

    public metadata: PreambleData = {
        macros: {},
        colors: {},
        tikzGlobal: "",
        tikzMacroMap: new Map(),
        authors: [],
        affiliations: [],
        keywords: [],
        custom: {}
    };
    public bibEntries: Map<string, BibEntry> = new Map();
    public rootDir: TUri | undefined;

    private bibCache: Map<string, BibCacheEntry> = new Map();
    private astSplitSnapshot: AstSplitSnapshot | undefined;
    private astSplitSnapshotKey: string | undefined;

    constructor(private readonly fileProvider: IFileProvider<TUri>, private readonly registry: RuleRegistry = SNAP_TEX_RULES) {}

    /**
     * Releases the transient body text after the renderer has taken a snapshot.
     * Block hashes are kept as compact stale-write guards for lazy AST artifact
     * updates; spans and text are no longer needed by the document after render.
     */
    public releaseTextContent() {
        this.bodyText = "";
        this.blockSpans = [];
    }

    public getBlockHash(index: number): string | undefined {
        return this.blockHashes[index];
    }

    public getAstBlockArtifact(index: number): AstBlockArtifact | undefined {
        return this.astBlockArtifacts[index];
    }

    public setAstBlockArtifact(index: number, artifact: AstBlockArtifact): void {
        if (this.blockHashes[index] === artifact.hash) {
            this.astBlockArtifacts[index] = artifact;
        }
    }

    public createTextSnapshot(): BlockTextSnapshot {
        return {
            bodyText: this.bodyText,
            blockSpans: this.blockSpans
        };
    }

    public applyResult(result: DocumentParseResult) {
        this.bodyText = result.bodyText;
        this.blockSpans = result.blockSpans;
        this.blockHashes = result.blockHashes;
        this.astBlockArtifacts = result.astBlockArtifacts;

        this.filePool = result.filePool;
        this.sourceMapSegments = result.sourceMapSegments;

        this.metadata = result.metadata;
        this.bibEntries = result.bibEntries;
        this.diagnostics = result.diagnostics;
        this.contentStartLineOffset = result.contentStartLineOffset;
    }

    /**
     * Parses a root .tex document into metadata, bibliography entries, source
     * mappings, and block spans.
     */
    public async parse(entryUri: TUri, contentOverride?: string, options: ParseOptions = {}): Promise<DocumentParseResult> {
        const filePool: string[] = [];

        const rootDir = this.fileProvider.dir(entryUri);
        this.rootDir = rootDir;

        const diagnostics: DocumentDiagnostic[] = [];
        const flattened: FlattenOutput = { textLines: [], sourceMapSegments: [] };
        await this.flattenInto(entryUri, filePool, flattened, diagnostics, 0, contentOverride);
        const { textLines, sourceMapSegments } = flattened;
        options.trace?.('after flatten');
        let normalizedText = textLines.join('\n');
        textLines.length = 0;

        const metaRes: MetadataResult = extractMetadata(normalizedText, this.registry.metadataExtractors);
        normalizedText = "";
        options.trace?.('after metadata');

        const bibEntries = await this.loadBibliography(metaRes.cleanedText, rootDir, diagnostics);

        let bodyText = metaRes.cleanedText;
        const cleanDocMatch = metaRes.cleanedText.match(/\\begin\{document\}/i);
        let contentStartLineOffset = 0;
        if (cleanDocMatch && cleanDocMatch.index !== undefined) {
            const startIndex = cleanDocMatch.index + cleanDocMatch[0].length;
            contentStartLineOffset = lineAtOffset(metaRes.cleanedText, startIndex);
            const endIndex = metaRes.cleanedText.search(/\\end\{document\}/i);
            bodyText = metaRes.cleanedText.substring(startIndex, endIndex === -1 ? metaRes.cleanedText.length : endIndex);
        }
        options.trace?.('after body slice');

        const useAstBackend = options.backendMode === 'ast(experimental)';
        const splitterOptions = {
            config: this.registry.splitterConfig,
            rules: this.registry.splitterRules
        };
        const astSplitKey = entryUri.toString();
        const astSplitResult = useAstBackend
            ? await splitLatexWithAstIncremental(
                bodyText,
                splitterOptions,
                this.astSplitSnapshotKey === astSplitKey ? this.astSplitSnapshot : undefined
            )
            : undefined;
        const rawBlockObjects = astSplitResult?.spans ?? LatexBlockSplitter.split(bodyText, splitterOptions);
        if (useAstBackend) {
            this.astSplitSnapshot = { text: bodyText, spans: rawBlockObjects, coarseSpans: astSplitResult?.coarseSpans };
            this.astSplitSnapshotKey = astSplitKey;
        } else {
            this.astSplitSnapshot = undefined;
            this.astSplitSnapshotKey = undefined;
        }
        options.trace?.('after split');

        const res: DocumentParseResult = {
            bodyText,
            blockSpans: [],
            blockHashes: [],
            astBlockArtifacts: [],
            filePool,
            sourceMapSegments,
            metadata: metaRes.data,
            bibEntries,
            diagnostics,
            contentStartLineOffset
        };
        const previousArtifacts = useAstBackend
            ? this.buildPreviousAstArtifactCache()
            : undefined;
        for (const b of rawBlockObjects) {
            const blockText = getBlockSpanText(bodyText, b);
            if (this.hasRenderableContent(blockText)) {
                const hash = stableHash(blockText);
                res.blockSpans.push(b);
                res.blockHashes.push(hash);
                if (useAstBackend) {
                    const cached = previousArtifacts?.get(hash);
                    res.astBlockArtifacts.push(cached ?? (
                        this.shouldBuildInitialAstArtifact(b)
                            ? await extractAstBlockArtifact(blockText, hash)
                            : undefined
                    ));
                }
            }
        }
        options.trace?.('after block hashes');

        return res;
    }

    private hasRenderableContent(text: string): boolean {
        const withoutListStructure = stripLatexComments(text)
            .replace(/\\(?:begin|end)\{(?:itemize|enumerate)\}/g, '')
            .replace(/\\item(?:\[[^\]]*\])?/g, '');

        return withoutListStructure.trim().length > 0;
    }

    private shouldBuildInitialAstArtifact(span: BlockTextSpan): boolean {
        return span.lineCount > this.registry.splitterConfig.maxBlockLines;
    }

    private buildPreviousAstArtifactCache(): Map<string, AstBlockArtifact> {
        const cache = new Map<string, AstBlockArtifact>();
        for (const artifact of this.astBlockArtifacts) {
            if (artifact) {
                cache.set(artifact.hash, artifact);
            }
        }
        return cache;
    }

    private async flattenInto(
        fileUri: TUri,
        filePool: string[],
        output: FlattenOutput,
        diagnostics: DocumentDiagnostic[],
        depth: number = 0,
        contentOverride?: string
    ): Promise<void> {
        if (depth > 20) {
            diagnostics.push({ message: `Input nesting is too deep near ${fileUri.toString()}` });
            return;
        }

        let content = "";
        const filePathStr = fileUri.toString();

        let currentFileIndex = filePool.indexOf(filePathStr);
        if (currentFileIndex === -1) {
            currentFileIndex = filePool.length;
            filePool.push(filePathStr);
        }

        if (contentOverride !== undefined) {
            content = contentOverride;
        } else {
            if (!(await this.fileProvider.exists(fileUri))) {
                diagnostics.push({ message: `Missing input file: ${filePathStr}` });
                appendFlattenedLine(output, `% [SnapTeX] File not found: ${filePathStr}`, currentFileIndex, 0);
                return;
            }
            try {
                content = await this.fileProvider.read(fileUri);
            } catch (e) {
                diagnostics.push({ message: `Error reading input file: ${filePathStr}` });
                appendFlattenedLine(output, `% [SnapTeX] Error reading: ${filePathStr}`, currentFileIndex, 0);
                return;
            }
        }

        const sourceLines = content.split(/\r?\n/);
        const selectedLines = depth > 0 ? this.selectStandaloneLines(sourceLines) : undefined;
        const inputRegex = /^(\s*)(?:\\input|\\include)\{([^}]+)\}/;
        const lineCount = selectedLines?.length ?? sourceLines.length;

        for (let i = 0; i < lineCount; i++) {
            const sourceLineNumber = selectedLines ? selectedLines[i] : i;
            const line = sourceLines[sourceLineNumber].replace(/\r/g, '');
            const trimmed = line.trim();

            if (trimmed.startsWith('%')) {
                appendFlattenedLine(output, line, currentFileIndex, sourceLineNumber);
                continue;
            }

            const match = line.match(inputRegex);
            if (match) {
                let relPath = match[2];
                if (!relPath.toLowerCase().endsWith('.tex')) { relPath += '.tex'; }

                const currentDir = this.fileProvider.dir(fileUri);
                const targetUri = this.fileProvider.resolve(currentDir, relPath);

                await this.flattenInto(targetUri, filePool, output, diagnostics, depth + 1);
            } else {
                appendFlattenedLine(output, line, currentFileIndex, sourceLineNumber);
            }
        }
    }

    private selectStandaloneLines(lines: string[]): number[] | undefined {
        const beginIndex = lines.findIndex(line => /\\begin\{document\}/i.test(line));
        if (beginIndex === -1) { return undefined; }

        const endOffset = lines.slice(beginIndex + 1).findIndex(line => /\\end\{document\}/i.test(line));
        if (endOffset === -1) { return undefined; }

        const endIndex = beginIndex + 1 + endOffset;
        const selected = this.extractPortablePreambleLines(lines, beginIndex);
        for (let index = beginIndex + 1; index < endIndex; index++) {
            selected.push(index);
        }
        return selected;
    }

    private extractPortablePreambleLines(lines: string[], endExclusive: number): number[] {
        const portableLines: number[] = [];
        let capturingDefinition = false;
        let braceDepth = 0;
        const portableCommandRegex = new RegExp(`^\\\\(?:${REGEX_STR.PREAMBLE_DEFINITIONS})\\*?(?=\\s|\\\\|\\{|\\[|$)`);

        for (let index = 0; index < endExclusive; index++) {
            const line = lines[index];
            const trimmed = line.trim();
            if (!capturingDefinition && !portableCommandRegex.test(trimmed)) {
                continue;
            }

            portableLines.push(index);
            capturingDefinition = true;
            braceDepth += scanLatexBraceBalance(line, { commentMode: 'stop' }).depth;

            if (braceDepth <= 0 && /}/.test(line)) {
                capturingDefinition = false;
                braceDepth = 0;
            }
        }

        return portableLines;
    }

    private async loadBibliography(text: string, rootDir: TUri, diagnostics: DocumentDiagnostic[]): Promise<Map<string, BibEntry>> {
        const inlineBibliography = text.match(R_THEBIBLIOGRAPHY);
        if (inlineBibliography) {
            return BibTexParser.parseBibItems(inlineBibliography[0]);
        }

        const match = text.match(R_BIBLIOGRAPHY);
        if (!match) { return new Map(); }

        let bibFile = match[1].trim();
        if (!bibFile.endsWith('.bib')) { bibFile += '.bib'; }
        const bibUri = this.fileProvider.resolve(rootDir, bibFile);
        const bibUriStr = bibUri.toString();

        try {
            const { mtime } = await this.fileProvider.stat(bibUri);
            if (mtime === 0) {
                diagnostics.push({ message: `Missing bibliography file: ${bibUriStr}` });
                return new Map();
            }
            const cached = this.bibCache.get(bibUriStr);
            if (cached && cached.mtime === mtime) { return cached.entries; }
            const entries = BibTexParser.parse(await this.fileProvider.read(bibUri));
            this.bibCache.set(bibUriStr, { mtime, entries });
            return entries;
        } catch (e) {
            console.error('Failed to load bib file:', e);
            diagnostics.push({ message: `Error reading bibliography file: ${bibUriStr}` });
        }
        return new Map();
    }

    public getOriginalPosition(flatLine: number): SourceLocation | undefined {
        if (flatLine < 0 || this.sourceMapSegments.length === 0) { return undefined; }
        let low = 0;
        let high = this.sourceMapSegments.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (this.sourceMapSegments[middle].flatStart <= flatLine) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        const segment = this.sourceMapSegments[low - 1];
        const offset = segment ? flatLine - segment.flatStart : -1;
        return segment && offset >= 0 && offset < segment.length
            ? { file: this.filePool[segment.fileIndex], line: segment.sourceStart + offset }
            : undefined;
    }

    /**
     * Maps an original source file/line pair into the flattened document line.
     */
    public getFlattenedLine(targetUriString: string, originalLine: number): number {
        const normTarget = normalizeUri(targetUriString);

        let bestLine = -1;
        let minDiff = Infinity;

        const matchingIndices = new Set<number>();
        for (let i = 0; i < this.filePool.length; i++) {
            const normLoc = normalizeUri(this.filePool[i]);
            if (normLoc === normTarget || normLoc.endsWith(normTarget) || normTarget.endsWith(normLoc)) {
                matchingIndices.add(i);
            }
        }

        if (matchingIndices.size === 0) {
            console.warn(`[SnapTeX] Failed to map source line. Target: ${normTarget}`);
            return bestLine;
        }

        for (const segment of this.sourceMapSegments) {
            if (!matchingIndices.has(segment.fileIndex)) { continue; }
            const offset = Math.max(0, Math.min(segment.length - 1, originalLine - segment.sourceStart));
            const diff = Math.abs(segment.sourceStart + offset - originalLine);
            if (diff < minDiff) {
                minDiff = diff;
                bestLine = segment.flatStart + offset;
            }
            if (diff === 0) { return bestLine; }
        }

        return bestLine;
    }
}
