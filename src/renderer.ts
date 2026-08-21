import MarkdownIt from 'markdown-it';

import { DiffEngine, DiffResult } from './diff';
import { BlockNumberingCounts, BlockTextSnapshot, BlockTextSpan, DependencyHelpers, DependencyState, NumberingPayload, RenderContext, RenderDependency, RenderedBlockMeta, RenderDocumentView, RenderOptions, RenderPayload, SourceLocation, SourceSyncOptions } from './types';
import type { AstBlockArtifact } from './ast/types';
import { renderLatexBlockWithAst } from './ast/renderer';
import { createDefaultAstRenderContext } from './ast/rules';
import { SNAP_TEX_RULES, postProcessHtml, type RuleRegistry } from './rules';
import { renderCitationHtml } from './rule-helpers';
import { LatexCounterScanner, type BlockScanInput, type ScanResult } from './scanner';
import { R_BIBLIOGRAPHY, R_THEBIBLIOGRAPHY } from './patterns';
import { countLineBreaks, extractLatexCitationKeys, extractLatexLabelNames, findNearestSyncAnchorLine, getBlockSpanText, lineAtOffset, normalizeUri, offsetAtLine, stableHash } from './utils';
import { ProtectionManager } from './protection';
import { renderIncludeGraphicsHtml } from './rule-floats';

const EMPTY_TEXT_SNAPSHOT: BlockTextSnapshot = { bodyText: "", blockSpans: [] };
interface BlockSnapshot extends RenderedBlockMeta {
    hasBibliography: boolean;
    citationKeys?: string[];
    dependencyFingerprint?: string;
}

interface RenderBlockAccess extends BlockScanInput {
    releaseTextCache(): void;
}

interface RenderPreparation extends RenderPreparationBase {
    numberingData: NumberingPayload;
    blockMeta: BlockSnapshot[];
    dirtyBlockIndices: number[];
}

interface RenderPreparationBase {
    blockAccess: RenderBlockAccess;
    diff: DiffResult;
    isFullUpdate: boolean;
    macrosChanged: boolean;
    nextTextSnapshot: BlockTextSnapshot;
}

/**
 * Converts a render document view into either a full render payload or a patch.
 *
 * SmartRenderer owns the preview-side document model snapshot: block hashes,
 * source-line mapping, label numbering, citation state, and the Markdown
 * protection pass. It is deliberately stateless with respect to host APIs;
 * apps/* hosts handle I/O and preview transport.
 */
export class SmartRenderer {
    private lastBlocks: BlockSnapshot[] = [];
    private lastTextSnapshot: BlockTextSnapshot = EMPTY_TEXT_SNAPSHOT;
    private lastMacrosJson: string = "";
    private dependencySummaries: Array<RenderDependency[] | undefined> = [];

    private md!: MarkdownIt;
    private protector = new ProtectionManager();
    private currentMacros: Record<string, string> = {};
    private readonly registry: RuleRegistry;

    private scanner = new LatexCounterScanner();
    private citedKeyNumbers = new Map<string, number>();
    private documentView: RenderDocumentView | undefined;
    private readonly renderContext: RenderContext;
    private readonly dependencyHelpers: DependencyHelpers = {
        metadata: path => ({
            id: `metadata:${path}`,
            read: state => this.readMetadataDependency(state.metadata, path)
        }),
        citedKeys: () => ({
            id: 'citations:list',
            read: state => state.citedKeysFingerprint
        })
    };

    constructor(registry: RuleRegistry = SNAP_TEX_RULES) {
        this.registry = registry;
        const renderer = this;
        this.renderContext = {
            get currentMacros() { return renderer.currentMacros; },
            get metadata() { return renderer.documentView?.metadata; },
            get bibEntries() { return renderer.documentView ? renderer.documentView.bibEntries : new Map(); },
            protectHtml: (namespace, html, mode) => this.protector.protect(namespace, html, mode),
            renderInline: text => this.md.renderInline(text),
            resolveCitation: key => this.resolveCitation(key),
            getCitedKeys: () => Array.from(renderer.citedKeyNumbers.keys())
        };
        this.rebuildMarkdownEngine({});
    }

    private readMetadataDependency(metadata: RenderDocumentView['metadata'], path: string): string {
        const value = path.split('.').reduce<unknown>((current, part) => {
            if (current === undefined || current === null || typeof current !== 'object') { return undefined; }
            return (current as Record<string, unknown>)[part];
        }, metadata);
        if (value === undefined || value === null) { return ''; }
        return typeof value === 'string' ? value : JSON.stringify(value);
    }

    /**
     * Rebuilds Markdown-it and applies the current macro table used by math rules.
     */
    private rebuildMarkdownEngine(macros: Record<string, string>) {
        this.currentMacros = {
            "\\mathparagraph": "\\P",
            "\\mathsection": "\\S",
            ...macros
        };
        this.md = new MarkdownIt({ html: false, linkify: true });
        this.md.disable('code');
    }

    public resetState() {
        this.lastBlocks = [];
        this.lastTextSnapshot = EMPTY_TEXT_SNAPSHOT;
        this.lastMacrosJson = "";
        this.dependencySummaries = [];
        this.citedKeyNumbers.clear();
        this.documentView = undefined;
        this.scanner.reset();
    }

    private resolveCitation(key: string): number {
        const existing = this.citedKeyNumbers.get(key);
        if (existing !== undefined) { return existing; }
        const number = this.citedKeyNumbers.size + 1;
        this.citedKeyNumbers.set(key, number);
        return number;
    }

    public isKnownFile(uriStr: string): boolean {
        if (!this.documentView) { return false; }
        const target = normalizeUri(uriStr);
        if (this.documentView.rootDir && normalizeUri(this.documentView.rootDir) === target) {
             return true;
        }
        return this.documentView.filePool.some(file => normalizeUri(file) === target);
    }

    private renderBlockToHtml(text: string, index: number, block = this.lastBlocks[index]): string {
        let processed = text;

        this.registry.renderRules.forEach(rule => { processed = rule.apply(processed, this.renderContext); });

        let finalHtml = this.md.render(processed);

        finalHtml = this.protector.resolve(finalHtml);

        if (finalHtml.includes('OOABSTRACT') || finalHtml.includes('OOKEYWORDS')) {
            finalHtml = postProcessHtml(finalHtml);
        }

        this.protector.reset();

        return `<div class="latex-block" data-index="${index}" data-block-hash="${block?.hash ?? stableHash(text)}">${finalHtml}</div>`;
    }

    private createAstRenderContext(sourceText: string) {
        return createDefaultAstRenderContext({
            sourceText,
            currentMacros: this.currentMacros,
            metadata: this.documentView?.metadata,
            bibEntries: this.documentView ? this.documentView.bibEntries : new Map(),
            resolveCitation: key => this.resolveCitation(key),
            getCitedKeys: () => Array.from(this.citedKeyNumbers.keys()),
            renderCitation: (command, keys, options) => renderCitationHtml(command, keys, options, this.renderContext),
            renderImage: path => renderIncludeGraphicsHtml(path)
        });
    }

    private async renderBlockToHtmlAsync(text: string, index: number, block = this.lastBlocks[index]): Promise<string> {
        const artifact = this.documentView?.getAstBlockArtifact(index);
        const result = await renderLatexBlockWithAst(text, {
            rules: this.registry.astRenderRules,
            context: this.createAstRenderContext(text),
            wrapper: {
                index,
                hash: artifact?.hash ?? stableHash(text),
                line: block?.line,
                lineCount: block?.lineCount
            }
        });
        this.documentView?.setAstBlockArtifact(index, result.artifact);
        return result.html;
    }

    private getSnapshotBlockText(snapshot: BlockTextSnapshot, index: number): string | undefined {
        const span = snapshot.blockSpans[index];
        if (!span) { return undefined; }
        return getBlockSpanText(snapshot.bodyText, span);
    }

    private createRenderBlockAccess(doc: RenderDocumentView, snapshot: BlockTextSnapshot): RenderBlockAccess {
        const textCache = new Map<number, string>();
        let textCacheEnabled = true;
        const getText = (index: number): string => {
            if (!textCacheEnabled) {
                return this.getSnapshotBlockText(snapshot, index) ?? '';
            }
            if (!textCache.has(index)) {
                const rawText = this.getSnapshotBlockText(snapshot, index) ?? '';
                textCache.set(index, rawText);
            }
            return textCache.get(index) ?? '';
        };
        const getHash = (index: number): string => {
            const rawHash = doc.getBlockHash(index);
            return rawHash ?? stableHash(getText(index));
        };

        return {
            count: snapshot.blockSpans.length,
            getText,
            releaseTextCache: () => {
                textCacheEnabled = false;
                textCache.clear();
            },
            hashes: Array.from({ length: snapshot.blockSpans.length }, (_unused, index) => getHash(index))
        };
    }

    private buildBlockMeta(
        doc: RenderDocumentView,
        span: BlockTextSpan | undefined,
        text: string,
        index: number,
        hash = stableHash(text),
        artifact?: AstBlockArtifact
    ): BlockSnapshot {
        const metadata = artifact?.parseOk ? artifact.metadata : undefined;
        const anchors = metadata ? metadata.labels : Array.from(new Set(extractLatexLabelNames(text)));
        const citationKeys = metadata ? metadata.citations : extractLatexCitationKeys(text);
        return {
            index,
            hash,
            line: doc.contentStartLineOffset + (span?.line ?? 0),
            lineCount: span?.lineCount ?? countLineBreaks(text) + 1,
            anchors: anchors.length > 0 ? anchors : undefined,
            hasBibliography: metadata
                ? metadata.macros.includes('bibliography') || metadata.environments.includes('thebibliography')
                : R_BIBLIOGRAPHY.test(text) || R_THEBIBLIOGRAPHY.test(text),
            citationKeys: citationKeys.length > 0 ? citationKeys : undefined
        };
    }

    private repositionBlockSnapshot(
        doc: RenderDocumentView,
        span: BlockTextSpan | undefined,
        block: BlockSnapshot,
        index: number
    ): BlockSnapshot {
        const line = doc.contentStartLineOffset + (span?.line ?? 0);
        const lineCount = span?.lineCount ?? block.lineCount;
        if (block.index === index && block.line === line && block.lineCount === lineCount) {
            return block;
        }
        return {
            ...block,
            index,
            line,
            lineCount
        };
    }

    private buildNextBlockSnapshots(
        doc: RenderDocumentView,
        spans: readonly BlockTextSpan[],
        diff: DiffResult,
        getBlockText: (index: number) => string,
        hashes: readonly string[],
        getBlockArtifact: (index: number) => AstBlockArtifact | undefined
    ): BlockSnapshot[] {
        const createBlockMeta = (index: number) => this.buildBlockMeta(
            doc,
            spans[index],
            getBlockText(index),
            index,
            hashes[index],
            getBlockArtifact(index)
        );
        return DiffEngine.rebuildArray(
            this.lastBlocks,
            spans.length,
            diff,
            createBlockMeta,
            (oldBlock, index) => {
                const repositioned = this.repositionBlockSnapshot(doc, spans[index], oldBlock, index);
                if (!repositioned.hasBibliography) { return repositioned; }
                return {
                    ...createBlockMeta(index),
                    dependencyFingerprint: repositioned.dependencyFingerprint
                };
            }
        );
    }

    private buildNumberingPayload(scanResult: ScanResult): NumberingPayload {
        const blocks: { [index: number]: BlockNumberingCounts } = {};
        scanResult.blockNumbering.forEach((counts, index) => {
            if (Object.values(counts).some(values => values.length > 0)) {
                blocks[index] = counts;
            }
        });
        return { blocks, labels: scanResult.labelMap };
    }

    public renderBlockByIndex(index: number): { hash: string; html?: string } | undefined {
        const block = this.lastBlocks[index];
        if (!block) { return undefined; }

        const text = this.getSnapshotBlockText(this.lastTextSnapshot, index);
        return {
            hash: block.hash,
            html: text === undefined ? undefined : this.renderBlockToHtml(text, index)
        };
    }

    public async renderBlockByIndexAsync(index: number): Promise<{ hash: string; html?: string } | undefined> {
        const block = this.lastBlocks[index];
        if (!block) { return undefined; }

        const text = this.getSnapshotBlockText(this.lastTextSnapshot, index);
        return {
            hash: block.hash,
            html: text === undefined ? undefined : await this.renderBlockToHtmlAsync(text, index)
        };
    }

    private collectBlockDependencies(text: string, index: number, artifact?: AstBlockArtifact): RenderDependency[] {
        return this.registry.blockDependencyRules.flatMap(rule => rule({ text, index, artifact, deps: this.dependencyHelpers }));
    }

    private updateDependencySummaries(
        blockCount: number,
        diff: DiffResult,
        getBlockText: (index: number) => string,
        getBlockArtifact: (index: number) => AstBlockArtifact | undefined
    ): Array<RenderDependency[] | undefined> {
        this.dependencySummaries = DiffEngine.rebuildArray(
            this.dependencySummaries,
            blockCount,
            diff,
            index => {
                const dependencies = this.collectBlockDependencies(getBlockText(index), index, getBlockArtifact(index));
                return dependencies.length > 0 ? dependencies : undefined;
            },
            summary => summary
        );
        return this.dependencySummaries;
    }

    private fingerprintDependencies(dependencies: readonly RenderDependency[], state: DependencyState): string {
        const parts = dependencies
            .map(dependency => `${dependency.id}\u0000${dependency.read(state)}`)
            .sort();
        return stableHash(parts.join('\u0001'));
    }

    private finalizeBlockSnapshots(
        blocks: BlockSnapshot[],
        summaries: readonly (readonly RenderDependency[] | undefined)[],
        state: DependencyState,
        citedKeys: readonly string[]
    ): BlockSnapshot[] {
        const bibliographyAnchors = citedKeys.map(key => `ref-${key}`);
        return blocks.map((block, index) => {
            const dependencies = summaries[index];
            const dependencyFingerprint = dependencies?.length
                ? this.fingerprintDependencies(dependencies, state)
                : undefined;
            const anchors = block.hasBibliography
                ? Array.from(new Set([...(block.anchors ?? []), ...bibliographyAnchors]))
                : block.anchors;
            if (anchors === block.anchors && block.dependencyFingerprint === dependencyFingerprint) { return block; }
            return {
                ...block,
                anchors,
                dependencyFingerprint
            };
        });
    }

    private collectDependencyDirtyBlockIndices(previousAlignedBlocks: BlockSnapshot[], nextBlocks: BlockSnapshot[], diff: DiffResult): number[] {
        const dirty: number[] = [];
        const patchStart = diff.start;
        const patchEnd = diff.start + diff.insertCount;

        for (let index = 0; index < nextBlocks.length; index++) {
            if (index >= patchStart && index < patchEnd) { continue; }

            const next = nextBlocks[index];
            const previous = previousAlignedBlocks[index];
            if (!next.dependencyFingerprint || !previous) { continue; }
            if (next.hash !== previous.hash) { continue; }
            if (next.dependencyFingerprint !== previous.dependencyFingerprint) {
                dirty.push(index);
            }
        }

        return dirty;
    }

    private prepareRenderBase(doc: RenderDocumentView, options: RenderOptions): RenderPreparationBase {
        this.documentView = doc;

        this.protector.reset();

        const currentMacrosJson = JSON.stringify(doc.metadata.macros);
        const macrosChanged = currentMacrosJson !== this.lastMacrosJson;
        if (macrosChanged) {
            this.rebuildMarkdownEngine(doc.metadata.macros);
            this.lastBlocks = [];
            this.lastTextSnapshot = EMPTY_TEXT_SNAPSHOT;
            this.dependencySummaries = [];
            this.lastMacrosJson = currentMacrosJson;
        }

        const nextTextSnapshot = doc.createTextSnapshot();
        const blockAccess = this.createRenderBlockAccess(doc, nextTextSnapshot);

        const diff = DiffEngine.compute(this.lastBlocks, blockAccess.hashes);

        const isFullUpdate = this.lastBlocks.length === 0 || diff.insertCount > 50 || diff.deleteCount > 50;
        if (isFullUpdate && options.deferFullHtml) {
            blockAccess.releaseTextCache();
        }

        return {
            blockAccess,
            diff,
            isFullUpdate,
            macrosChanged,
            nextTextSnapshot
        };
    }

    private finishRenderPreparation(doc: RenderDocumentView, base: RenderPreparationBase, scanResult: ScanResult): RenderPreparation {
        const numberingData = this.buildNumberingPayload(scanResult);

        const getBlockArtifact = (index: number) => doc.getAstBlockArtifact(index);
        let blockMeta = this.buildNextBlockSnapshots(
            doc,
            base.nextTextSnapshot.blockSpans,
            base.diff,
            base.blockAccess.getText,
            base.blockAccess.hashes,
            getBlockArtifact
        );
        const citedKeySet = new Set<string>();
        for (const block of blockMeta) {
            for (const key of block.citationKeys ?? []) { citedKeySet.add(key); }
        }
        const nextCitedKeys = [...citedKeySet];
        this.citedKeyNumbers = new Map(nextCitedKeys.map((key, index) => [key, index + 1]));
        const previousAlignedBlocks = blockMeta;
        const dependencySummaries = this.updateDependencySummaries(
            base.blockAccess.count,
            base.diff,
            base.blockAccess.getText,
            getBlockArtifact
        );
        blockMeta = this.finalizeBlockSnapshots(
            blockMeta,
            dependencySummaries,
            {
                metadata: doc.metadata,
                citedKeysFingerprint: stableHash([...nextCitedKeys].sort().join('\0'))
            },
            nextCitedKeys
        );
        const dirtyBlockIndices = this.collectDependencyDirtyBlockIndices(previousAlignedBlocks, blockMeta, base.diff);
        return {
            ...base,
            numberingData,
            blockMeta,
            dirtyBlockIndices
        };
    }

    private prepareRenderState(doc: RenderDocumentView, options: RenderOptions): RenderPreparation {
        const base = this.prepareRenderBase(doc, options);
        return this.finishRenderPreparation(doc, base, this.scanner.scan(base.blockAccess));
    }

    private commitRenderState(prepared: RenderPreparation) {
        this.lastBlocks = prepared.blockMeta;
        this.lastTextSnapshot = prepared.nextTextSnapshot;
    }

    private buildFullPayload(prepared: RenderPreparation, options: RenderOptions, htmls: string[] | undefined): RenderPayload {
        return options.deferFullHtml
            ? {
                type: 'full',
                blocks: prepared.blockMeta,
                resetPreviewState: options.resetPreviewState,
                numbering: prepared.numberingData
            }
            : {
                type: 'full',
                htmls: htmls ?? [],
                preserveUnchangedBlocks: !prepared.macrosChanged && !options.resetPreviewState,
                resetPreviewState: options.resetPreviewState,
                numbering: prepared.numberingData
            };
    }

    private buildPatchPayload(prepared: RenderPreparation, insertedHtmls: string[], dirtyBlocks?: { [index: number]: string }): RenderPayload {
        let shift = 0;
        if (prepared.diff.end > 0 && insertedHtmls.length !== prepared.diff.deleteCount) {
            shift = insertedHtmls.length - prepared.diff.deleteCount;
        }

        return {
            type: 'patch',
            start: prepared.diff.start,
            deleteCount: prepared.diff.deleteCount,
            htmls: insertedHtmls,
            shift,
            numbering: prepared.numberingData,
            dirtyBlocks
        };
    }

    private getInsertedBlockIndices(prepared: RenderPreparation): number[] {
        return Array.from(
            { length: prepared.diff.insertCount },
            (_unused, offset) => prepared.diff.start + offset
        );
    }

    private getDirtyBlockRenderJobs(indices: readonly number[]): Array<[index: number, text: string]> {
        return indices.flatMap(index => {
            const text = this.getSnapshotBlockText(this.lastTextSnapshot, index);
            return text === undefined ? [] : [[index, text]];
        });
    }

    /**
     * Renders a parsed document and returns the minimal webview update payload.
     *
     * The full-update threshold intentionally remains a fixed 50 changed blocks.
     * Virtual mode may request metadata-only full payloads; individual block HTML
     * is then rendered lazily by index from lastTextSnapshot.
     */
    public render(doc: RenderDocumentView, options: RenderOptions = {}): RenderPayload {
        const prepared = this.prepareRenderState(doc, options);
        let payload: RenderPayload;

        if (prepared.isFullUpdate) {
            this.commitRenderState(prepared);
            const htmls = options.deferFullHtml
                ? undefined
                : Array.from({ length: prepared.blockAccess.count }, (_unused, index) => this.renderBlockToHtml(prepared.blockAccess.getText(index), index, prepared.blockMeta[index]));
            payload = this.buildFullPayload(prepared, options, htmls);
        } else {
            const insertedHtmls = this.getInsertedBlockIndices(prepared)
                .map(index => this.renderBlockToHtml(prepared.blockAccess.getText(index), index, prepared.blockMeta[index]));

            this.commitRenderState(prepared);

            let dirtyBlocks: { [index: number]: string } | undefined;
            for (const [index, text] of this.getDirtyBlockRenderJobs(prepared.dirtyBlockIndices)) {
                dirtyBlocks ??= {};
                dirtyBlocks[index] = this.renderBlockToHtml(text, index);
            }

            payload = this.buildPatchPayload(prepared, insertedHtmls, dirtyBlocks);
        }

        return payload;
    }

    public async renderAsync(doc: RenderDocumentView, options: RenderOptions = {}): Promise<RenderPayload> {
        const prepared = this.prepareRenderState(doc, options);
        let payload: RenderPayload;

        if (prepared.isFullUpdate) {
            this.commitRenderState(prepared);
            let htmls: string[] | undefined;
            if (!options.deferFullHtml) {
                htmls = [];
                for (let index = 0; index < prepared.blockAccess.count; index++) {
                    htmls.push(await this.renderBlockToHtmlAsync(
                        prepared.blockAccess.getText(index),
                        index,
                        prepared.blockMeta[index]
                    ));
                }
            }
            payload = this.buildFullPayload(prepared, options, htmls);
        } else {
            const insertedHtmls: string[] = [];
            for (const index of this.getInsertedBlockIndices(prepared)) {
                insertedHtmls.push(await this.renderBlockToHtmlAsync(
                    prepared.blockAccess.getText(index),
                    index,
                    prepared.blockMeta[index]
                ));
            }

            this.commitRenderState(prepared);

            let dirtyBlocks: { [index: number]: string } | undefined;
            for (const [index, text] of this.getDirtyBlockRenderJobs(prepared.dirtyBlockIndices)) {
                dirtyBlocks ??= {};
                dirtyBlocks[index] = await this.renderBlockToHtmlAsync(text, index);
            }

            payload = this.buildPatchPayload(prepared, insertedHtmls, dirtyBlocks);
        }

        return payload;
    }

    public getPreviewSyncData(filePath: string, line: number, character?: number) {
        if (!this.documentView) {return null;}
        const flatLine = this.documentView.getFlattenedLine(filePath, line);
        return flatLine !== -1 ? this.getBlockIndexByLine(flatLine, character) : null;
    }

    public getSourceSyncData(blockIndex: number, ratio: number, options: SourceSyncOptions = {}): SourceLocation | null {
        if (!this.documentView) {return null;}
        const flatLine = this.getLineByBlockIndex(blockIndex, ratio, options);
        return this.documentView.getOriginalPosition(flatLine) ?? null;
    }

    private getBlockIndexByLine(line: number, character?: number): { index: number; ratio: number; sourceStart?: number; sourceEnd?: number } {
        if (this.lastBlocks.length === 0 || line < this.lastBlocks[0].line) { return { index: 0, ratio: 0 }; }
        let low = 0;
        let high = this.lastBlocks.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (this.lastBlocks[middle].line <= line) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        const index = low - 1;
        const block = this.lastBlocks[index];
        const anchor = this.getAstPreviewAnchor(index, line - block.line, character);
        return anchor
            ? { index, ...anchor }
            : { index, ratio: Math.max(0, Math.min(1, (line - block.line) / Math.max(1, block.lineCount))) };
    }

    private getLineByBlockIndex(index: number, ratio: number, options: SourceSyncOptions): number {
        const sourceLine = this.getLineBySourceOffset(index, options.sourceStart, options.sourceEnd);
        if (sourceLine !== undefined) { return sourceLine; }
        const estimatedLine = this.getLineByBlockRatio(index, ratio);
        return this.refineLineByAnchors(index, estimatedLine, options.anchors ?? []) ?? estimatedLine;
    }

    private getLineBySourceOffset(index: number, sourceStart: number | undefined, sourceEnd: number | undefined): number | undefined {
        if (sourceStart === undefined) { return undefined; }

        const block = this.lastBlocks[index];
        const source = this.getSyncBlockSource(index);
        if (!block || !source) { return undefined; }

        const targetOffset = sourceEnd === undefined
            ? sourceStart
            : Math.floor((sourceStart + sourceEnd) / 2);
        return block.line + lineAtOffset(source.text, targetOffset - source.prefixLength);
    }

    private getLineByBlockRatio(index: number, ratio: number): number {
        const block = this.lastBlocks[index];
        if (block) {
            const line = Math.floor(block.lineCount * Math.max(0, Math.min(1, ratio)));
            return block.line + Math.min(Math.max(0, block.lineCount - 1), line);
        }
        return 0;
    }

    private refineLineByAnchors(index: number, estimatedFlatLine: number, anchors: readonly string[]): number | undefined {
        if (anchors.length === 0) { return undefined; }

        const block = this.lastBlocks[index];
        const source = this.getSyncBlockSource(index);
        if (!block || !source) { return undefined; }

        const lines = source.text.split(/\r?\n/);
        const estimatedLineInBlock = Math.max(0, Math.min(block.lineCount - 1, estimatedFlatLine - block.line));
        const matchedLine = findNearestSyncAnchorLine(
            anchors,
            0,
            Math.min(lines.length - 1, Math.max(0, block.lineCount - 1)),
            estimatedLineInBlock,
            line => lines[line] ?? ''
        );
        return matchedLine === undefined ? undefined : block.line + matchedLine;
    }

    private getSyncBlockSource(index: number): { text: string; prefixLength: number; startColumn: number } | undefined {
        const span = this.lastTextSnapshot.blockSpans[index];
        if (!span) { return undefined; }
        const lineStart = span.start > 0
            ? this.lastTextSnapshot.bodyText.lastIndexOf('\n', span.start - 1) + 1
            : 0;
        return {
            text: this.lastTextSnapshot.bodyText.slice(span.start, span.end),
            prefixLength: span.prefix?.length ?? 0,
            startColumn: span.start - lineStart
        };
    }

    private getAstPreviewAnchor(index: number, lineInBlock: number, character?: number): { ratio: number; sourceStart: number; sourceEnd: number } | undefined {
        if (character === undefined) { return undefined; }

        const block = this.lastBlocks[index];
        const artifact = this.documentView?.getAstBlockArtifact(index);
        const source = this.getSyncBlockSource(index);
        if (!block || !artifact || !source || artifact.sourceHints.starts.length === 0) {
            return undefined;
        }

        const lineColumnOffset = lineInBlock === 0 ? source.startColumn : 0;
        const sourceOffset = source.prefixLength
            + offsetAtLine(source.text, lineInBlock)
            + Math.max(0, character - lineColumnOffset);
        for (let hintIndex = 0; hintIndex < artifact.sourceHints.starts.length; hintIndex++) {
            const start = artifact.sourceHints.starts[hintIndex];
            const end = artifact.sourceHints.ends[hintIndex];
            if (sourceOffset >= start && sourceOffset <= end) {
                const hintLine = lineAtOffset(source.text, Math.floor((start + end) / 2) - source.prefixLength);
                return {
                    ratio: Math.max(0, Math.min(1, hintLine / Math.max(1, block.lineCount))),
                    sourceStart: start,
                    sourceEnd: end
                };
            }
        }
        return undefined;
    }

}
