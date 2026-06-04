import * as vscode from 'vscode';
import { IFileProvider } from './file-provider';
import { extractMetadata } from './metadata';
import { BibTexParser, BibEntry } from './bib';
import { SourceLocation, PreambleData, MetadataResult } from './types';
import { R_BIBLIOGRAPHY } from './patterns';
import { BlockSpan, LatexBlockSplitter } from './splitter';
import { normalizeUri, stableHash } from './utils';

export interface DocumentParseResult {
    bodyText: string;
    blockSpans: BlockSpan[];
    blockHashes: string[];
    blockLines: number[];
    blockLineCounts: number[];
    // memory-efficient TypedArrays
    filePool: string[];
    sourceFileIndices: Uint16Array;
    sourceLines: Int32Array;
    metadata: PreambleData;
    bibEntries: Map<string, BibEntry>;
    contentStartLineOffset: number;
}

export interface BlockTextSnapshot {
    bodyText: string;
    blockSpans: BlockSpan[];
    blockHashes: string[];
}

// Cache Entry Interface
interface BibCacheEntry {
    mtime: number;
    entries: Map<string, BibEntry>;
}

interface IndexedLine {
    text: string;
    line: number;
}

export class LatexDocument {
    private bodyText: string = "";
    public blockSpans: BlockSpan[] = [];
    public blockHashes: string[] = [];
    public blockLines: number[] = [];
    public blockLineCounts: number[] = [];

    public filePool: string[] = [];
    public sourceFileIndices: Uint16Array = new Uint16Array(0);
    public sourceLines: Int32Array = new Int32Array(0);

    public contentStartLineOffset: number = 0;

    public metadata: PreambleData = {
        macros: {},
        tikzGlobal: "",
        tikzMacroMap: new Map()
    };
    public bibEntries: Map<string, BibEntry> = new Map();
    public rootDir: vscode.Uri | undefined;

    // Cache for BibTeX files
    private bibCache: Map<string, BibCacheEntry> = new Map();

    constructor(private fileProvider: IFileProvider) {}

    public releaseTextContent() {
        this.bodyText = "";
        this.blockSpans = [];
        this.blockHashes = [];
        this.blockLines = [];
        this.blockLineCounts = [];
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

    public getBlockSpan(index: number): BlockSpan | undefined {
        return this.blockSpans[index];
    }

    public createTextSnapshot(): BlockTextSnapshot {
        return {
            bodyText: this.bodyText,
            blockSpans: [...this.blockSpans],
            blockHashes: [...this.blockHashes]
        };
    }

    public applyResult(result: DocumentParseResult) {
        this.bodyText = result.bodyText;
        this.blockSpans = result.blockSpans;
        this.blockHashes = result.blockHashes;
        this.blockLines = result.blockLines;
        this.blockLineCounts = result.blockLineCounts;

        // Apply optimized arrays
        this.filePool = result.filePool;
        this.sourceFileIndices = result.sourceFileIndices;
        this.sourceLines = result.sourceLines;

        this.metadata = result.metadata;
        this.bibEntries = result.bibEntries;
        this.contentStartLineOffset = result.contentStartLineOffset;
    }

    public async parse(entryUri: vscode.Uri, contentOverride?: string): Promise<DocumentParseResult> {
        // Using filePool directly for string interning
        const filePool: string[] = [];

        const rootDir = this.fileProvider.dir(entryUri);
        this.rootDir = rootDir;

        // 1. Load (Now returns parallel raw arrays)
        const { textLines, fileIndices, lines } = await this.loadAndFlatten(entryUri, filePool, 0, contentOverride);
        // const rawText = textLines.join('\n');
        const normalizedText = textLines.join('\n');

        // 2. Metadata
        // const normalizedText = rawText.replace(/\r\n/g, '\n');
        const metaRes: MetadataResult = extractMetadata(normalizedText);

        // 3. Bib (With Caching)
        const bibEntries = await this.loadBibliography(metaRes.cleanedText, rootDir);

        // 4. Offset
        let contentStartLineOffset = 0;
        const rawDocMatch = normalizedText.match(/\\begin\{document\}/i);
        if (rawDocMatch && rawDocMatch.index !== undefined) {
            const preContent = normalizedText.substring(0, rawDocMatch.index + rawDocMatch[0].length);
            contentStartLineOffset = preContent.split('\n').length - 1;
        }

        // 5. Split
        let bodyText = metaRes.cleanedText;
        if (rawDocMatch && rawDocMatch.index !== undefined) {
             const cleanDocMatch = metaRes.cleanedText.match(/\\begin\{document\}/i);
             if (cleanDocMatch && cleanDocMatch.index !== undefined) {
                 const startIndex = cleanDocMatch.index + cleanDocMatch[0].length;
                 let endIndex = metaRes.cleanedText.search(/\\end\{document\}/i);
                 if (endIndex === -1) {
                     endIndex = metaRes.cleanedText.length;
                 }
                 bodyText = metaRes.cleanedText.substring(startIndex, endIndex);
             }
        }
        const rawBlockObjects = LatexBlockSplitter.split(bodyText);

        const res: DocumentParseResult = {
            bodyText,
            blockSpans: [],
            blockHashes: [],
            blockLines: [],
            blockLineCounts: [],
            // TypedArray to seal memory
            filePool: filePool,
            sourceFileIndices: new Uint16Array(fileIndices),
            sourceLines: new Int32Array(lines),
            metadata: metaRes.data,
            bibEntries: bibEntries,
            contentStartLineOffset: contentStartLineOffset
        };

        for (const b of rawBlockObjects) {
            const blockText = bodyText.slice(b.start, b.end);
            if (this.hasRenderableContent(blockText)) {
                res.blockSpans.push(b);
                res.blockHashes.push(stableHash(blockText));
                res.blockLines.push(b.line);
                res.blockLineCounts.push(b.lineCount);
            }
        }

        return res;
    }

    private hasRenderableContent(text: string): boolean {
        const withoutComments = text
            .split(/\r?\n/)
            .map(line => {
                const commentStart = line.search(/(?<!\\)%/);
                return commentStart === -1 ? line : line.substring(0, commentStart);
            })
            .join('\n');

        const withoutListStructure = withoutComments
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
        const fallback = { textLines: [], fileIndices: [], lines: [] };
        if (depth > 20) { return fallback; }

        let content = "";
        const filePathStr = fileUri.toString();

        // Find or add the current file to the String Pool
        let currentFileIndex = filePool.indexOf(filePathStr);
        if (currentFileIndex === -1) {
            currentFileIndex = filePool.length;
            filePool.push(filePathStr);
        }

        if (contentOverride !== undefined) {
            content = contentOverride;
        } else {
            // Check existence before reading to avoid error throwing overhead
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
        // Collect primitive numbers instead of Objects
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
            braceDepth += this.getBraceDelta(line.text);

            if (braceDepth <= 0 && /}/.test(line.text)) {
                capturingDefinition = false;
                braceDepth = 0;
            }
        }

        return portableLines;
    }

    private getBraceDelta(line: string): number {
        let delta = 0;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '\\') {
                i++;
                continue;
            }
            if (char === '%') {
                break;
            }
            if (char === '{') {
                delta++;
            } else if (char === '}') {
                delta--;
            }
        }
        return delta;
    }

    private async loadBibliography(text: string, rootDir: vscode.Uri): Promise<Map<string, BibEntry>> {
        const match = text.match(R_BIBLIOGRAPHY);
        if (match && rootDir) {
            let bibFile = match[1].trim();
            if (!bibFile.endsWith('.bib')) { bibFile += '.bib'; }
            const bibUri = this.fileProvider.resolve(rootDir, bibFile);
            const bibUriStr = bibUri.toString();

            try {
                const { mtime } = await this.fileProvider.stat(bibUri);
                if (mtime === 0) { return new Map(); }
                const cached = this.bibCache.get(bibUriStr);
                if (cached && cached.mtime === mtime) { return cached.entries; }
                const content = await this.fileProvider.read(bibUri);
                const entries = BibTexParser.parse(content);
                this.bibCache.set(bibUriStr, { mtime, entries });
                return entries;
            } catch (e) {
                console.error('Failed to load bib file:', e);
            }
        }
        return new Map();
    }

    public getOriginalPosition(flatLine: number): SourceLocation | undefined {
        // Reconstruct SourceLocation on demand from TypedArrays
        if (flatLine >= 0 && flatLine < this.sourceLines.length) {
            return {
                file: this.filePool[this.sourceFileIndices[flatLine]],
                line: this.sourceLines[flatLine]
            };
        }
        return undefined;
    }

    public getFlattenedLine(targetUriString: string, originalLine: number): number {
        const normTarget = normalizeUri(targetUriString);

        let bestLine = -1;
        let minDiff = Infinity;

        // Fast-path: Pre-calculate matching file indices.
        // This avoids executing heavy string normalization 50,000+ times inside the main loop.
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

        // Iterate over flat primitive arrays (extremely fast and cache-friendly)
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
