import type { IFileProvider } from './file-provider';
import { extractMetadata } from './metadata';
import { BibTexParser } from './bib';
import { BibEntry, SourceLocation, PreambleData, MetadataResult, BlockTextSnapshot, BlockTextSpan, RenderDocumentView, UriLike } from './types';
import { R_BIBLIOGRAPHY, R_THEBIBLIOGRAPHY } from './patterns';
import { SNAP_TEX_RULES } from './rules';
import { LatexBlockSplitter } from './splitter';
import { normalizeUri, scanLatexBraceBalance, stableHash, stripLatexComments } from './utils';

export interface DocumentParseResult {
    bodyText: string;
    blockSpans: BlockTextSpan[];
    blockHashes: string[];
    filePool: string[];
    sourceFileIndices: Uint16Array;
    sourceLines: Int32Array;
    metadata: PreambleData;
    bibEntries: Map<string, BibEntry>;
    contentStartLineOffset: number;
}

interface BibCacheEntry {
    mtime: number;
    entries: Map<string, BibEntry>;
}

interface FlattenOutput {
    textLines: string[];
    fileIndices: number[];
    lines: number[];
}

interface ParseOptions {
    trace?: (label: string) => void;
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
    public blockSpans: BlockTextSpan[] = [];
    public blockHashes: string[] = [];

    public filePool: string[] = [];
    public sourceFileIndices: Uint16Array = new Uint16Array(0);
    public sourceLines: Int32Array = new Int32Array(0);

    public contentStartLineOffset: number = 0;

    public metadata: PreambleData = {
        macros: {},
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

    constructor(private fileProvider: IFileProvider<TUri>, private registry = SNAP_TEX_RULES) {}

    /**
     * Releases the transient body text after the renderer has taken a snapshot.
     */
    public releaseTextContent() {
        this.bodyText = "";
        this.blockSpans = [];
        this.blockHashes = [];
    }

    public getBlockCount(): number {
        return this.blockSpans.length;
    }

    public getBlockText(index: number): string | undefined {
        const span = this.blockSpans[index];
        if (!span) { return undefined; }
        return this.bodyText.slice(span.start, span.end);
    }

    public getBlockHash(index: number): string | undefined {
        return this.blockHashes[index];
    }

    public createTextSnapshot(): BlockTextSnapshot {
        return {
            bodyText: this.bodyText,
            blockSpans: [...this.blockSpans]
        };
    }

    public applyResult(result: DocumentParseResult) {
        this.bodyText = result.bodyText;
        this.blockSpans = result.blockSpans;
        this.blockHashes = result.blockHashes;

        this.filePool = result.filePool;
        this.sourceFileIndices = result.sourceFileIndices;
        this.sourceLines = result.sourceLines;

        this.metadata = result.metadata;
        this.bibEntries = result.bibEntries;
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

        const { textLines, fileIndices, lines } = await this.loadAndFlatten(entryUri, filePool, 0, contentOverride);
        options.trace?.('after flatten');
        let normalizedText = textLines.join('\n');
        textLines.length = 0;

        let contentStartLineOffset = 0;
        const rawDocMatch = normalizedText.match(/\\begin\{document\}/i);
        if (rawDocMatch && rawDocMatch.index !== undefined) {
            contentStartLineOffset = this.countNewlinesBefore(normalizedText, rawDocMatch.index + rawDocMatch[0].length);
        }

        const metaRes: MetadataResult = extractMetadata(normalizedText, this.registry.metadataExtractors);
        normalizedText = "";
        options.trace?.('after metadata');

        const bibEntries = await this.loadBibliography(metaRes.cleanedText, rootDir);

        let bodyText = metaRes.cleanedText;
        const cleanDocMatch = metaRes.cleanedText.match(/\\begin\{document\}/i);
        if (cleanDocMatch && cleanDocMatch.index !== undefined) {
            const startIndex = cleanDocMatch.index + cleanDocMatch[0].length;
            const endIndex = metaRes.cleanedText.search(/\\end\{document\}/i);
            bodyText = metaRes.cleanedText.substring(startIndex, endIndex === -1 ? metaRes.cleanedText.length : endIndex);
        }
        options.trace?.('after body slice');

        const rawBlockObjects = LatexBlockSplitter.split(bodyText, {
            config: this.registry.splitterConfig,
            rules: this.registry.splitterRules
        });
        options.trace?.('after split');

        const res: DocumentParseResult = {
            bodyText,
            blockSpans: [],
            blockHashes: [],
            filePool,
            sourceFileIndices: new Uint16Array(fileIndices),
            sourceLines: new Int32Array(lines),
            metadata: metaRes.data,
            bibEntries,
            contentStartLineOffset
        };
        fileIndices.length = 0;
        lines.length = 0;

        for (const b of rawBlockObjects) {
            const blockText = bodyText.slice(b.start, b.end);
            if (this.hasRenderableContent(blockText)) {
                res.blockSpans.push(b);
                res.blockHashes.push(stableHash(blockText));
            }
        }
        options.trace?.('after block hashes');

        return res;
    }

    private countNewlinesBefore(text: string, endExclusive: number): number {
        let count = 0;
        const limit = Math.min(endExclusive, text.length);
        for (let index = 0; index < limit; index++) {
            if (text.charCodeAt(index) === 10) { count++; }
        }
        return count;
    }

    private hasRenderableContent(text: string): boolean {
        const withoutListStructure = stripLatexComments(text)
            .replace(/\\(?:begin|end)\{(?:itemize|enumerate)\}/g, '')
            .replace(/\\item(?:\[[^\]]*\])?/g, '');

        return withoutListStructure.trim().length > 0;
    }

    private async loadAndFlatten(
        fileUri: TUri,
        filePool: string[],
        depth: number = 0,
        contentOverride?: string
    ): Promise<FlattenOutput> {
        const output: FlattenOutput = { textLines: [], fileIndices: [], lines: [] };
        await this.flattenInto(fileUri, filePool, output, depth, contentOverride);
        return output;
    }

    private async flattenInto(
        fileUri: TUri,
        filePool: string[],
        output: FlattenOutput,
        depth: number = 0,
        contentOverride?: string
    ): Promise<void> {
        if (depth > 20) { return; }

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
                output.textLines.push(`% [SnapTeX] File not found: ${filePathStr}`);
                output.fileIndices.push(currentFileIndex);
                output.lines.push(0);
                return;
            }
            try {
                content = await this.fileProvider.read(fileUri);
            } catch (e) {
                output.textLines.push(`% [SnapTeX] Error reading: ${filePathStr}`);
                output.fileIndices.push(currentFileIndex);
                output.lines.push(0);
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
                output.textLines.push(line);
                output.fileIndices.push(currentFileIndex);
                output.lines.push(sourceLineNumber);
                continue;
            }

            const match = line.match(inputRegex);
            if (match) {
                let relPath = match[2];
                if (!relPath.toLowerCase().endsWith('.tex')) { relPath += '.tex'; }

                const currentDir = this.fileProvider.dir(fileUri);
                const targetUri = this.fileProvider.resolve(currentDir, relPath);

                await this.flattenInto(targetUri, filePool, output, depth + 1);
            } else {
                output.textLines.push(line);
                output.fileIndices.push(currentFileIndex);
                output.lines.push(sourceLineNumber);
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
        const portableCommandRegex = /^\\(?:(?:provide|re)?newcommand\*?|g?def|DeclareMathOperator\*?|usetikzlibrary|tikzset|definecolor)(?=\s|\\|\{|\[|$)/;

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

    private async loadBibliography(text: string, rootDir: TUri): Promise<Map<string, BibEntry>> {
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
            if (mtime === 0) { return new Map(); }
            const cached = this.bibCache.get(bibUriStr);
            if (cached && cached.mtime === mtime) { return cached.entries; }
            const entries = BibTexParser.parse(await this.fileProvider.read(bibUri));
            this.bibCache.set(bibUriStr, { mtime, entries });
            return entries;
        } catch (e) {
            console.error('Failed to load bib file:', e);
        }
        return new Map();
    }

    public getOriginalPosition(flatLine: number): SourceLocation | undefined {
        if (flatLine >= 0 && flatLine < this.sourceLines.length) {
            return {
                file: this.filePool[this.sourceFileIndices[flatLine]],
                line: this.sourceLines[flatLine]
            };
        }
        return undefined;
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

        const len = this.sourceLines.length;
        for (let i = 0; i < len; i++) {
            if (matchingIndices.has(this.sourceFileIndices[i])) {
                const diff = Math.abs(this.sourceLines[i] - originalLine);
                if (diff < minDiff) {
                    minDiff = diff;
                    bestLine = i;
                }
                if (diff === 0) { return i; }
            }
        }

        return bestLine;
    }
}
