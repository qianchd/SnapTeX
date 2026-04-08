import * as vscode from 'vscode';
import { IFileProvider } from './file-provider';
import { extractMetadata } from './metadata';
import { BibTexParser, BibEntry } from './bib';
import { SourceLocation, PreambleData, MetadataResult } from './types';
import { R_BIBLIOGRAPHY } from './patterns';
import { LatexBlockSplitter } from './splitter';
import { normalizeUri } from './utils';

export interface DocumentParseResult {
    blockTexts: string[];
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

// Cache Entry Interface
interface BibCacheEntry {
    mtime: number;
    entries: Map<string, BibEntry>;
}

export class LatexDocument {
    public blockTexts: string[] = [];
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
        this.blockTexts = [];
    }

    public applyResult(result: DocumentParseResult) {
        this.blockTexts = result.blockTexts;
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
                 bodyText = metaRes.cleanedText.substring(cleanDocMatch.index + cleanDocMatch[0].length)
                     .replace(/\\end\{document\}[\s\S]*/i, '');
             }
        }

        const rawBlockObjects = LatexBlockSplitter.split(bodyText);

        const res: DocumentParseResult = {
            blockTexts: [],
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
            if (b.text.trim().length > 0) {
                // const flattenedText = (' ' + b.text).slice(1);
                res.blockTexts.push(b.text);
                res.blockLines.push(b.line);
                res.blockLineCounts.push(b.lineCount);
            }
        }

        return res;
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

        const rawLines = content.split(/\r?\n/);
        const flattenedLines: string[] = [];
        // Collect primitive numbers instead of Objects
        const outIndices: number[] = [];
        const outLines: number[] = [];
        const inputRegex = /^(\s*)(?:\\input|\\include)\{([^}]+)\}/;

        for (let i = 0; i < rawLines.length; i++) {
            const line = rawLines[i].replace(/\r/g, '');
            const trimmed = line.trim();

            if (trimmed.startsWith('%')) {
                flattenedLines.push(line);
                outIndices.push(currentFileIndex);
                outLines.push(i);
                continue;
            }

            const match = line.match(inputRegex);
            if (match) {
                let relPath = match[2];
                if (!relPath.toLowerCase().endsWith('.tex')) { relPath += '.tex'; }

                const currentDir = this.fileProvider.dir(fileUri);
                const targetUri = this.fileProvider.resolve(currentDir, relPath);

                const result = await this.loadAndFlatten(targetUri, filePool, depth + 1);

                flattenedLines.push(...result.textLines);
                outIndices.push(...result.fileIndices);
                outLines.push(...result.lines);
            } else {
                flattenedLines.push(line);
                outIndices.push(currentFileIndex);
                outLines.push(i);
            }
        }

        return { textLines: flattenedLines, fileIndices: outIndices, lines: outLines };
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