import * as vscode from 'vscode';
import { IFileProvider } from './file-provider';
import { extractMetadata } from './metadata';
import { BibTexParser, BibEntry } from './bib';
import { SourceLocation, PreambleData, MetadataResult } from './types';
import { R_BIBLIOGRAPHY } from './patterns';
import { LatexBlockSplitter } from './splitter';

export interface DocumentParseResult {
    blockTexts: string[];
    blockLines: number[];
    blockLineCounts: number[];
    sourceMap: SourceLocation[];
    metadata: PreambleData;
    bibEntries: Map<string, BibEntry>;
    contentStartLineOffset: number;
}

// [NEW] Cache Entry Interface
interface BibCacheEntry {
    mtime: number;
    entries: Map<string, BibEntry>;
}

export class LatexDocument {
    public blockTexts: string[] = [];
    public blockLines: number[] = [];
    public blockLineCounts: number[] = [];

    public sourceMap: SourceLocation[] = [];
    public contentStartLineOffset: number = 0;

    public metadata: PreambleData = { macros: {} };
    public bibEntries: Map<string, BibEntry> = new Map();
    public rootDir: vscode.Uri | undefined;

    // [NEW] Cache for BibTeX files
    private bibCache: Map<string, BibCacheEntry> = new Map();

    constructor(private fileProvider: IFileProvider) {}

    public releaseTextContent() {
        this.blockTexts = [];
    }

    public applyResult(result: DocumentParseResult) {
        this.blockTexts = result.blockTexts;
        this.blockLines = result.blockLines;
        this.blockLineCounts = result.blockLineCounts;
        this.sourceMap = result.sourceMap;
        this.metadata = result.metadata;
        this.bibEntries = result.bibEntries;
        this.contentStartLineOffset = result.contentStartLineOffset;
    }

    public async parse(entryUri: vscode.Uri, contentOverride?: string): Promise<DocumentParseResult> {
        const localPathPool = new Map<string, string>();
        const intern = (s: string) => {
            let c = localPathPool.get(s);
            if (!c) { c = s; localPathPool.set(s, s); }
            return c;
        };

        const rootDir = this.fileProvider.dir(entryUri);
        this.rootDir = rootDir;

        // 1. Load
        const { textLines, map } = await this.loadAndFlatten(entryUri, intern, 0, contentOverride);
        const rawText = textLines.join('\n');

        // 2. Metadata
        const normalizedText = rawText.replace(/\r\n/g, '\n');
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
            sourceMap: map,
            metadata: metaRes.data,
            bibEntries: bibEntries,
            contentStartLineOffset: contentStartLineOffset
        };

        for (const b of rawBlockObjects) {
            if (b.text.trim().length > 0) {
                res.blockTexts.push(b.text);
                res.blockLines.push(b.line);
                res.blockLineCounts.push(b.lineCount);
            }
        }

        return res;
    }

    private async loadAndFlatten(
        fileUri: vscode.Uri,
        intern: (s: string) => string,
        depth: number = 0,
        contentOverride?: string
    ): Promise<{ textLines: string[], map: SourceLocation[] }> {
        const fallback = { textLines: [], map: [] };
        if (depth > 20) { return fallback; }

        let content = "";
        const filePathStr = fileUri.toString();

        if (contentOverride !== undefined) {
            content = contentOverride;
        } else {
            // [Optimization] Check existence before reading to avoid error throwing overhead
            if (!(await this.fileProvider.exists(fileUri))) {
                return {
                    textLines: [`% [SnapTeX] File not found: ${filePathStr}`],
                    map: [{ file: filePathStr, line: 0 }]
                };
            }
            try {
                content = await this.fileProvider.read(fileUri);
            } catch (e) {
                return {
                    textLines: [`% [SnapTeX] Error reading: ${filePathStr}`],
                    map: [{ file: filePathStr, line: 0 }]
                };
            }
        }

        const rawLines = content.split(/\r?\n/);
        const flattenedLines: string[] = [];
        const sourceMap: SourceLocation[] = [];
        const inputRegex = /^(\s*)(?:\\input|\\include)\{([^}]+)\}/;

        const internedPath = intern(fileUri.toString());

        for (let i = 0; i < rawLines.length; i++) {
            const line = rawLines[i];
            const trimmed = line.trim();

            if (trimmed.startsWith('%')) {
                flattenedLines.push(line);
                sourceMap.push({ file: internedPath, line: i });
                continue;
            }

            const match = line.match(inputRegex);
            if (match) {
                let relPath = match[2];
                if (!relPath.toLowerCase().endsWith('.tex')) { relPath += '.tex'; }

                const currentDir = this.fileProvider.dir(fileUri);
                const targetUri = this.fileProvider.resolve(currentDir, relPath);

                const result = await this.loadAndFlatten(targetUri, intern, depth + 1);

                flattenedLines.push(...result.textLines);
                sourceMap.push(...result.map);
            } else {
                flattenedLines.push(line);
                sourceMap.push({ file: internedPath, line: i });
            }
        }

        return { textLines: flattenedLines, map: sourceMap };
    }

    /**
     * Loads Bibliography with Mtime Caching.
     * Prevents re-parsing large .bib files if they haven't changed.
     */
    private async loadBibliography(text: string, rootDir: vscode.Uri): Promise<Map<string, BibEntry>> {
        const match = text.match(R_BIBLIOGRAPHY);
        if (match && rootDir) {
            let bibFile = match[1].trim();
            if (!bibFile.endsWith('.bib')) { bibFile += '.bib'; }
            const bibUri = this.fileProvider.resolve(rootDir, bibFile);
            const bibUriStr = bibUri.toString();

            try {
                // 1. Get file stats (lightweight)
                const { mtime } = await this.fileProvider.stat(bibUri);

                if (mtime === 0) {
                    // File doesn't exist
                    return new Map();
                }

                // 2. Check Cache
                const cached = this.bibCache.get(bibUriStr);
                if (cached && cached.mtime === mtime) {
                    // Cache Hit: Return previous result
                    return cached.entries;
                }

                // 3. Cache Miss: Read and Parse
                const content = await this.fileProvider.read(bibUri);
                const entries = BibTexParser.parse(content);

                // 4. Update Cache
                this.bibCache.set(bibUriStr, { mtime, entries });
                return entries;

            } catch (e) {
                console.error('Failed to load bib file:', e);
            }
        }
        return new Map();
    }

    public getOriginalPosition(flatLine: number): SourceLocation | undefined {
        if (flatLine >= 0 && flatLine < this.sourceMap.length) {
            return this.sourceMap[flatLine];
        }
        return undefined;
    }

    public getFlattenedLine(fsPath: string, originalLine: number): number {
        const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
        const normTarget = normalize(fsPath);

        let bestLine = -1;
        let minDiff = Infinity;

        for (let i = 0; i < this.sourceMap.length; i++) {
            const loc = this.sourceMap[i];
            const normLoc = normalize(loc.file);
            if (normLoc.endsWith(normTarget) || normTarget.endsWith(normLoc)) {
                const diff = Math.abs(loc.line - originalLine);
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