import * as vscode from 'vscode';
import { IFileProvider } from './file-provider';
import { extractMetadata } from './metadata';
import { BibTexParser } from './bib';
import { BibEntry, SourceLocation, PreambleData, MetadataResult, BlockTextSnapshot, BlockTextSpan, RenderDocumentView } from './types';
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

interface IndexedLine {
    text: string;
    line: number;
}

/**
 * Parsed LaTeX document state used by the renderer.
 *
 * LatexDocument flattens the root document and supported subfiles into one body
 * string, stores block spans instead of duplicated block strings, and keeps
 * compact source maps for editor-preview synchronization.
 */
export class LatexDocument implements RenderDocumentView {
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
    public rootDir: vscode.Uri | undefined;

    private bibCache: Map<string, BibCacheEntry> = new Map();

    constructor(private fileProvider: IFileProvider, private registry = SNAP_TEX_RULES) {}

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
    public async parse(entryUri: vscode.Uri, contentOverride?: string): Promise<DocumentParseResult> {
        const filePool: string[] = [];

        const rootDir = this.fileProvider.dir(entryUri);
        this.rootDir = rootDir;

        const { textLines, fileIndices, lines } = await this.loadAndFlatten(entryUri, filePool, 0, contentOverride);
        const normalizedText = textLines.join('\n');

        const metaRes: MetadataResult = extractMetadata(normalizedText, this.registry.metadataExtractors);

        const bibEntries = await this.loadBibliography(metaRes.cleanedText, rootDir);

        let contentStartLineOffset = 0;
        const rawDocMatch = normalizedText.match(/\\begin\{document\}/i);
        if (rawDocMatch && rawDocMatch.index !== undefined) {
            const preContent = normalizedText.substring(0, rawDocMatch.index + rawDocMatch[0].length);
            contentStartLineOffset = preContent.split('\n').length - 1;
        }

        let bodyText = metaRes.cleanedText;
        const cleanDocMatch = metaRes.cleanedText.match(/\\begin\{document\}/i);
        if (cleanDocMatch && cleanDocMatch.index !== undefined) {
            const startIndex = cleanDocMatch.index + cleanDocMatch[0].length;
            const endIndex = metaRes.cleanedText.search(/\\end\{document\}/i);
            bodyText = metaRes.cleanedText.substring(startIndex, endIndex === -1 ? metaRes.cleanedText.length : endIndex);
        }
        const rawBlockObjects = LatexBlockSplitter.split(bodyText, {
            config: this.registry.splitterConfig,
            rules: this.registry.splitterRules
        });

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

        for (const b of rawBlockObjects) {
            const blockText = bodyText.slice(b.start, b.end);
            if (this.hasRenderableContent(blockText)) {
                res.blockSpans.push(b);
                res.blockHashes.push(stableHash(blockText));
            }
        }

        return res;
    }

    private hasRenderableContent(text: string): boolean {
        const withoutListStructure = stripLatexComments(text)
            .replace(/\\(?:begin|end)\{(?:itemize|enumerate)\}/g, '')
            .replace(/\\item(?:\[[^\]]*\])?/g, '');

        return withoutListStructure.trim().length > 0;
    }

    private async loadAndFlatten(
        fileUri: vscode.Uri,
        filePool: string[],
        depth: number = 0,
        contentOverride?: string
    ): Promise<{ textLines: string[], fileIndices: number[], lines: number[] }> {
        if (depth > 20) { return { textLines: [], fileIndices: [], lines: [] }; }

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
                return {
                    textLines: [`% [SnapTeX] File not found: ${filePathStr}`],
                    fileIndices: [currentFileIndex],
                    lines: [0]
                };
            }
            try {
                content = await this.fileProvider.read(fileUri);
            } catch (e) {
                return {
                    textLines: [`% [SnapTeX] Error reading: ${filePathStr}`],
                    fileIndices: [currentFileIndex],
                    lines: [0]
                };
            }
        }

        const sourceLines = content.split(/\r?\n/).map((text, line) => ({ text, line }));
        const rawLines = depth > 0 ? this.stripStandaloneWrapper(sourceLines) : sourceLines;
        const flattenedLines: string[] = [];
        const outIndices: number[] = [];
        const outLines: number[] = [];
        const inputRegex = /^(\s*)(?:\\input|\\include)\{([^}]+)\}/;

        for (let i = 0; i < rawLines.length; i++) {
            const sourceLine = rawLines[i];
            const line = sourceLine.text.replace(/\r/g, '');
            const trimmed = line.trim();

            if (trimmed.startsWith('%')) {
                flattenedLines.push(line);
                outIndices.push(currentFileIndex);
                outLines.push(sourceLine.line);
                continue;
            }

            const match = line.match(inputRegex);
            if (match) {
                let relPath = match[2];
                if (!relPath.toLowerCase().endsWith('.tex')) { relPath += '.tex'; }

                const currentDir = this.fileProvider.dir(fileUri);
                const targetUri = this.fileProvider.resolve(currentDir, relPath);

                const result = await this.loadAndFlatten(targetUri, filePool, depth + 1);
                const len = result.textLines.length;
                for (let j = 0; j < len; j++) {
                    flattenedLines.push(result.textLines[j]);
                    outIndices.push(result.fileIndices[j]);
                    outLines.push(result.lines[j]);
                }
            } else {
                flattenedLines.push(line);
                outIndices.push(currentFileIndex);
                outLines.push(sourceLine.line);
            }
        }

        return { textLines: flattenedLines, fileIndices: outIndices, lines: outLines };
    }

    private stripStandaloneWrapper(lines: IndexedLine[]): IndexedLine[] {
        const beginIndex = lines.findIndex(line => /\\begin\{document\}/i.test(line.text));
        if (beginIndex === -1) { return lines; }

        const endOffset = lines.slice(beginIndex + 1).findIndex(line => /\\end\{document\}/i.test(line.text));
        if (endOffset === -1) { return lines; }

        const endIndex = beginIndex + 1 + endOffset;
        return [
            ...this.extractPortablePreambleLines(lines.slice(0, beginIndex)),
            ...lines.slice(beginIndex + 1, endIndex)
        ];
    }

    private extractPortablePreambleLines(lines: IndexedLine[]): IndexedLine[] {
        const portableLines: IndexedLine[] = [];
        let capturingDefinition = false;
        let braceDepth = 0;
        const portableCommandRegex = /^\\(?:(?:provide|re)?newcommand\*?|g?def|DeclareMathOperator\*?|usetikzlibrary|tikzset|definecolor)(?=\s|\\|\{|\[|$)/;

        for (const line of lines) {
            const trimmed = line.text.trim();
            if (!capturingDefinition && !portableCommandRegex.test(trimmed)) {
                continue;
            }

            portableLines.push(line);
            capturingDefinition = true;
            braceDepth += scanLatexBraceBalance(line.text, { commentMode: 'stop' }).depth;

            if (braceDepth <= 0 && /}/.test(line.text)) {
                capturingDefinition = false;
                braceDepth = 0;
            }
        }

        return portableLines;
    }

    private async loadBibliography(text: string, rootDir: vscode.Uri): Promise<Map<string, BibEntry>> {
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
