import { IFileProvider } from './file-provider';
import { extractMetadata } from './metadata';
import { BibTexParser, BibEntry } from './bib';
import { SourceLocation, PreambleData, MetadataResult } from './types';
import { R_BIBLIOGRAPHY } from './patterns';
import { LatexBlockSplitter, BlockResult } from './splitter';

/**
 * Represents the parsed state of a LaTeX document.
 * Responsibilities: Loading, Flattening, Metadata Extraction, Bib Loading, and Block Splitting.
 */
export class LatexDocument {
    // Structure needed for Sync and Rendering
    public sourceMap: SourceLocation[] = []; // Maps flattened line index -> original file/line
    public blocks: BlockResult[] = [];       // The split blocks (holding the actual content)
    public contentStartLineOffset: number = 0;

    // Parsed Metadata
    public metadata: PreambleData = { macros: {} };

    // Bibliography
    public bibEntries: Map<string, BibEntry> = new Map();
    public rootDir: string = "";

    constructor(private fileProvider: IFileProvider) {}

    /**
     * Re-parses the document from the given entry path.
     * @param entryPath The file system path to the root .tex file.
     * @param contentOverride Optional content to use for the root file (e.g., from dirty editor).
     */
    public reparse(entryPath: string, contentOverride?: string) {
        this.rootDir = this.fileProvider.dir(entryPath);

        // 1. Load and flatten (handle \input recursively)
        // [Memory Note] textLines is now local.
        const { textLines, map } = this.loadAndFlatten(entryPath, 0, contentOverride);

        // We persist the map for sync, but discard the lines after joining.
        this.sourceMap = map;
        const rawText = textLines.join('\n'); // Local variable

        // 2. Normalize and Extract Metadata
        const normalizedText = rawText.replace(/\r\n/g, '\n');
        const metaRes: MetadataResult = extractMetadata(normalizedText);

        this.metadata = metaRes.data;
        const cleanedText = metaRes.cleanedText; // Local variable

        // 3. Load Bibliography
        this.loadBibliography(cleanedText);

        // 4. Calculate Body Content Offset
        this.calculateContentOffset(normalizedText);

        // 5. Split into Blocks
        // We trim the preamble from the text before splitting to avoid interference
        let bodyText = cleanedText;
        const rawDocMatch = normalizedText.match(/\\begin\{document\}/i);
        if (rawDocMatch && rawDocMatch.index !== undefined) {
             const cleanDocMatch = cleanedText.match(/\\begin\{document\}/i);
             if (cleanDocMatch && cleanDocMatch.index !== undefined) {
                 // Extract only the body content inside \begin{document}...\end{document}
                 bodyText = cleanedText.substring(cleanDocMatch.index + cleanDocMatch[0].length)
                     .replace(/\\end\{document\}[\s\S]*/i, '');
             }
        }

        const rawBlockObjects = LatexBlockSplitter.split(bodyText);
        // Filter empty blocks
        this.blocks = rawBlockObjects.filter(b => b.text.trim().length > 0);

        // End of reparse: rawText, cleanedText, textLines go out of scope and are collected.
    }

    private loadAndFlatten(filePath: string, depth: number = 0, contentOverride?: string): { textLines: string[], map: SourceLocation[] } {
        const fallback = { textLines: [], map: [] };
        if (depth > 20) { return fallback; } // Recursion limit

        let content = "";

        if (contentOverride !== undefined) {
            content = contentOverride;
        } else {
            if (!this.fileProvider.exists(filePath)) {
                return {
                    textLines: [`% [SnapTeX] File not found: ${filePath}`],
                    map: [{ file: filePath, line: 0 }]
                };
            }
            try {
                content = this.fileProvider.read(filePath);
            } catch (e) {
                return {
                    textLines: [`% [SnapTeX] Error reading: ${filePath}`],
                    map: [{ file: filePath, line: 0 }]
                };
            }
        }

        const rawLines = content.split(/\r?\n/);
        const flattenedLines: string[] = [];
        const sourceMap: SourceLocation[] = [];
        const inputRegex = /^(\s*)(?:\\input|\\include)\{([^}]+)\}/;

        for (let i = 0; i < rawLines.length; i++) {
            const line = rawLines[i];
            const trimmed = line.trim();

            if (trimmed.startsWith('%')) {
                flattenedLines.push(line);
                sourceMap.push({ file: filePath, line: i });
                continue;
            }

            const match = line.match(inputRegex);
            if (match) {
                const relPath = match[2];
                const currentDir = this.fileProvider.dir(filePath);
                const targetPath = this.fileProvider.resolve(currentDir, relPath);

                // Recursive load
                const result = this.loadAndFlatten(targetPath, depth + 1);

                flattenedLines.push(...result.textLines);
                sourceMap.push(...result.map);
            } else {
                flattenedLines.push(line);
                sourceMap.push({ file: filePath, line: i });
            }
        }

        return { textLines: flattenedLines, map: sourceMap };
    }

    private loadBibliography(text: string) {
        const match = text.match(R_BIBLIOGRAPHY);
        if (match && this.rootDir) {
            let bibFile = match[1].trim();
            if (!bibFile.endsWith('.bib')) { bibFile += '.bib'; }
            const bibPath = this.fileProvider.resolve(this.rootDir, bibFile);

            if (this.fileProvider.exists(bibPath)) {
                try {
                    const content = this.fileProvider.read(bibPath);
                    this.bibEntries = BibTexParser.parse(content);
                } catch (e) {
                    console.error('Failed to load bib file:', e);
                    this.bibEntries.clear();
                }
            }
        } else {
            this.bibEntries.clear();
        }
    }

    private calculateContentOffset(normalizedText: string) {
        this.contentStartLineOffset = 0;
        const rawDocMatch = normalizedText.match(/\\begin\{document\}/i);
        if (rawDocMatch && rawDocMatch.index !== undefined) {
            const preContent = normalizedText.substring(0, rawDocMatch.index + rawDocMatch[0].length);
            this.contentStartLineOffset = preContent.split('\n').length - 1;
        }
    }

    public getOriginalPosition(flatLine: number): SourceLocation | undefined {
        if (flatLine >= 0 && flatLine < this.sourceMap.length) {
            return this.sourceMap[flatLine];
        }
        return undefined;
    }

    public getFlattenedLine(fsPath: string, originalLine: number): number {
        // Simple normalization
        const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
        const normTarget = normalize(fsPath);

        let bestLine = -1;
        let minDiff = Infinity;

        for (let i = 0; i < this.sourceMap.length; i++) {
            const loc = this.sourceMap[i];
            if (normalize(loc.file) === normTarget) {
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