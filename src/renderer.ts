import MarkdownIt from 'markdown-it';

import { DiffEngine, DiffResult } from './diff';
import { BlockNumberingCounts, BlockTextSnapshot, DependencyHelpers, DependencyState, NumberingPayload, RenderContext, RenderDependency, RenderedBlockMeta, RenderDocumentView, RenderOptions, RenderPayload, RuleRegistry, SourceLocation } from './types';
import { AST_SOURCE_HINT_KIND, type AstBlockArtifact } from './ast/block-metadata';
import { renderLatexBlockWithAst } from './ast/renderer';
import { createDefaultAstRenderContext } from './ast/rules';
import { SNAP_TEX_RULES, postProcessHtml, renderCitationHtml } from './rules';
import { LatexCounterScanner, type ScanResult } from './scanner';
import { R_BIBLIOGRAPHY, R_THEBIBLIOGRAPHY } from './patterns';
import { extractLatexCitationKeys, extractLatexLabelNames, findNearestSyncAnchorLine, getBlockSpanText, lineAtOffset, normalizeUri, offsetAtLine, stableHash } from './utils';
import { ProtectionManager } from './protection';
import { renderIncludeGraphicsHtml } from './rule-floats';

const EMPTY_TEXT_SNAPSHOT: BlockTextSnapshot = { bodyText: "", blockSpans: [] };
const SOURCE_SYNC_HINT_KINDS = new Set<number>([
    AST_SOURCE_HINT_KIND.InlineMath,
    AST_SOURCE_HINT_KIND.DisplayMath,
    AST_SOURCE_HINT_KIND.Ref,
    AST_SOURCE_HINT_KIND.Citation,
    AST_SOURCE_HINT_KIND.Section,
    AST_SOURCE_HINT_KIND.ListItem
]);

interface BlockSnapshot extends RenderedBlockMeta {
    hasBibliography: boolean;
    citationKeys: string[];
    dependencyFingerprint?: string;
}

interface RenderBlockAccess {
    getText(index: number): string;
    setTextCacheEnabled(enabled: boolean): void;
    hashBlocks: { hash: string }[];
    provider: {
        getBlockCount(): number;
        getBlockText(index: number): string;
        getBlockHash(index: number): string;
    };
}

interface RenderPreparation {
    blockCount: number;
    blockAccess: RenderBlockAccess;
    diff: DiffResult;
    isFullUpdate: boolean;
    macrosChanged: boolean;
    numberingData: NumberingPayload;
    blockMeta: BlockSnapshot[];
    dirtyBlockIndices: number[];
    nextTextSnapshot: BlockTextSnapshot;
}

interface RenderPreparationBase {
    blockCount: number;
    blockAccess: RenderBlockAccess;
    diff: DiffResult;
    isFullUpdate: boolean;
    macrosChanged: boolean;
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

    private md: MarkdownIt | null = null;
    private protector = new ProtectionManager();
    private currentMacros: Record<string, string> = {};
    private readonly registry: RuleRegistry;

    private blockMap: { start: number; count: number }[] = [];
    private scanner = new LatexCounterScanner();
    private _citedKeys: string[] = [];
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
            renderInline: text => this.renderInline(text),
            resolveCitation: key => this.resolveCitation(key),
            getCitedKeys: () => renderer._citedKeys
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
        this.blockMap = [];
        this._citedKeys = [];
        this.documentView = undefined;
        this.scanner.reset();
    }

    /**
     * Renders inline Markdown from rule helpers without running the full block pipeline.
     */
    private renderInline(text: string): string {
        return this.md ? this.md.renderInline(text) : text;
    }

    private resolveCitation(key: string): number {
        let index = this._citedKeys.indexOf(key);
        if (index === -1) {
            this._citedKeys.push(key);
            index = this._citedKeys.length - 1;
        }
        return index + 1;
    }

    public isKnownFile(uriStr: string): boolean {
        if (!this.documentView) { return false; }
        const target = normalizeUri(uriStr);
        if (this.documentView.rootDir && normalizeUri(this.documentView.rootDir) === target) {
             return true;
        }
        return this.documentView.filePool.some(file => normalizeUri(file) === target);
    }

    private renderBlockToHtml(text: string, index: number): string {
        let processed = text;

        this.registry.renderRules.forEach(rule => { processed = rule.apply(processed, this.renderContext); });

        let finalHtml = this.md!.render(processed);

        finalHtml = this.protector.resolve(finalHtml);

        if (finalHtml.includes('OOABSTRACT') || finalHtml.includes('OOKEYWORDS')) {
            finalHtml = postProcessHtml(finalHtml);
        }

        this.protector.reset();

        return `<div class="latex-block" data-index="${index}" data-block-hash="${stableHash(text)}">${finalHtml}</div>`;
    }

    private createAstRenderContext(sourceText: string) {
        return createDefaultAstRenderContext({
            sourceText,
            currentMacros: this.currentMacros,
            metadata: this.documentView?.metadata,
            bibEntries: this.documentView ? this.documentView.bibEntries : new Map(),
            renderCitation: (command, keys, options) => renderCitationHtml(command, keys, {
                pre: options.pre ? `${options.pre} ` : undefined,
                post: options.post
            }, this.renderContext),
            renderImage: path => renderIncludeGraphicsHtml(path)
        });
    }

    private async renderBlockToHtmlAsync(text: string, index: number): Promise<string> {
        const artifact = this.documentView?.getAstBlockArtifact(index);
        const map = this.blockMap[index];
        const result = await renderLatexBlockWithAst(text, {
            rules: this.registry.astRenderRules,
            context: this.createAstRenderContext(text),
            wrapper: {
                index,
                hash: artifact?.hash ?? stableHash(text),
                line: map?.start,
                lineCount: map?.count
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

    private createRenderBlockAccess(doc: RenderDocumentView, blockCount: number): RenderBlockAccess {
        const textCache = new Map<number, string>();
        let textCacheEnabled = true;
        const getText = (index: number): string => {
            if (!textCacheEnabled) {
                return doc.getBlockText(index) ?? '';
            }
            if (!textCache.has(index)) {
                const rawText = doc.getBlockText(index) ?? '';
                textCache.set(index, rawText);
            }
            return textCache.get(index) ?? '';
        };
        const getHash = (index: number): string => {
            const rawHash = doc.getBlockHash(index);
            return rawHash ?? stableHash(getText(index));
        };

        return {
            getText,
            setTextCacheEnabled: (enabled: boolean) => {
                textCacheEnabled = enabled;
                if (!enabled) { textCache.clear(); }
            },
            hashBlocks: Array.from({ length: blockCount }, (_unused, index) => ({ hash: getHash(index) })),
            provider: {
                getBlockCount: () => blockCount,
                getBlockText: getText,
                getBlockHash: getHash
            }
        };
    }

    private buildBlockMeta(text: string, index: number, hash = stableHash(text), artifact?: AstBlockArtifact): BlockSnapshot {
        const map = this.blockMap[index];
        const metadata = artifact?.parseOk ? artifact.metadata : undefined;
        return {
            index,
            hash,
            line: map?.start ?? 0,
            lineCount: map?.count ?? text.split(/\r?\n/).length,
            anchors: metadata ? [...metadata.labels] : Array.from(new Set(extractLatexLabelNames(text))),
            hasBibliography: metadata
                ? metadata.macros.includes('bibliography') || metadata.environments.includes('thebibliography')
                : R_BIBLIOGRAPHY.test(text) || R_THEBIBLIOGRAPHY.test(text),
            citationKeys: metadata ? [...metadata.citations] : extractLatexCitationKeys(text)
        };
    }

    private repositionBlockSnapshot(block: BlockSnapshot, index: number): BlockSnapshot {
        const map = this.blockMap[index];
        return {
            ...block,
            index,
            line: map?.start ?? 0,
            lineCount: map?.count ?? block.lineCount
        };
    }

    private buildNextBlockSnapshots(
        blockCount: number,
        diff: DiffResult,
        getBlockText: (index: number) => string,
        hashes: readonly { hash: string }[],
        getBlockArtifact: (index: number) => AstBlockArtifact | undefined
    ): BlockSnapshot[] {
        const createBlockMeta = (index: number) => this.buildBlockMeta(
            getBlockText(index),
            index,
            hashes[index]?.hash,
            getBlockArtifact(index)
        );
        return DiffEngine.rebuildArray(
            this.lastBlocks,
            blockCount,
            diff,
            createBlockMeta,
            (oldBlock, index) => this.repositionBlockSnapshot(oldBlock, index)
        );
    }

    private collectCitedKeys(blocks: BlockSnapshot[]): string[] {
        return Array.from(new Set(blocks.flatMap(block => block.citationKeys)));
    }

    private fingerprintCitedKeySet(citedKeys: readonly string[]): string {
        return stableHash(Array.from(new Set(citedKeys)).sort().join('\0'));
    }

    private applyBibliographyAnchors(blocks: BlockSnapshot[], citedKeys: string[]): BlockSnapshot[] {
        return blocks.map(block => {
            if (!block.hasBibliography) { return block; }
            const anchors = new Set(block.anchors);
            citedKeys.forEach(key => anchors.add(`ref-${key}`));
            return {
                ...block,
                anchors: Array.from(anchors)
            };
        });
    }

    private buildNumberingPayload(scanResult: {
        blockNumbering: Array<{ counts: BlockNumberingCounts }>;
        labelMap: Record<string, string>;
    }): NumberingPayload {
        const blocks: { [index: number]: BlockNumberingCounts } = {};
        scanResult.blockNumbering.forEach((blockNumbering, index) => {
            if (Object.values(blockNumbering.counts).some(values => values.length > 0)) {
                blocks[index] = blockNumbering.counts;
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
        return this.registry.blockDependencyRules.flatMap(rule => rule.collect({ text, index, artifact, deps: this.dependencyHelpers }));
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

    private applyDependencyFingerprints(
        blocks: BlockSnapshot[],
        summaries: readonly (readonly RenderDependency[] | undefined)[],
        state: DependencyState
    ): BlockSnapshot[] {
        return blocks.map((block, index) => {
            const dependencies = summaries[index] ?? [];
            if (dependencies.length === 0) {
                return { ...block, dependencyFingerprint: undefined };
            }
            return {
                ...block,
                dependencyFingerprint: this.fingerprintDependencies(dependencies, state)
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

        const blockCount = doc.getBlockCount();
        const blockAccess = this.createRenderBlockAccess(doc, blockCount);

        this.blockMap = doc.blockSpans.map(span => ({
            start: doc.contentStartLineOffset + span.line,
            count: span.lineCount
        }));

        const diff = DiffEngine.compute(this.lastBlocks, blockAccess.hashBlocks);

        const isFullUpdate = this.lastBlocks.length === 0 || diff.insertCount > 50 || diff.deleteCount > 50;
        blockAccess.setTextCacheEnabled(!(isFullUpdate && options.deferFullHtml));

        return {
            blockCount,
            blockAccess,
            diff,
            isFullUpdate,
            macrosChanged
        };
    }

    private finishRenderPreparation(doc: RenderDocumentView, base: RenderPreparationBase, scanResult: ScanResult): RenderPreparation {
        const numberingData = this.buildNumberingPayload(scanResult);

        const getBlockArtifact = (index: number) => doc.getAstBlockArtifact(index);
        let blockMeta = this.buildNextBlockSnapshots(
            base.blockCount,
            base.diff,
            base.blockAccess.getText,
            base.blockAccess.hashBlocks,
            getBlockArtifact
        );
        const nextCitedKeys = this.collectCitedKeys(blockMeta);
        this._citedKeys = nextCitedKeys;
        blockMeta = this.applyBibliographyAnchors(blockMeta, nextCitedKeys);
        const previousAlignedBlocks = blockMeta;
        const dependencySummaries = this.updateDependencySummaries(
            base.blockCount,
            base.diff,
            base.blockAccess.getText,
            getBlockArtifact
        );
        blockMeta = this.applyDependencyFingerprints(blockMeta, dependencySummaries, {
            metadata: doc.metadata,
            citedKeysFingerprint: this.fingerprintCitedKeySet(nextCitedKeys)
        });
        const dirtyBlockIndices = this.collectDependencyDirtyBlockIndices(previousAlignedBlocks, blockMeta, base.diff);
        const nextTextSnapshot = doc.createTextSnapshot();

        return {
            ...base,
            numberingData,
            blockMeta,
            dirtyBlockIndices,
            nextTextSnapshot
        };
    }

    private prepareRenderState(doc: RenderDocumentView, options: RenderOptions): RenderPreparation {
        const base = this.prepareRenderBase(doc, options);
        return this.finishRenderPreparation(doc, base, this.scanner.scan(base.blockAccess.provider));
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

    private async renderAllBlocksAsync(prepared: RenderPreparation): Promise<string[]> {
        const htmls: string[] = [];
        for (let index = 0; index < prepared.blockCount; index++) {
            htmls.push(await this.renderBlockToHtmlAsync(prepared.blockAccess.getText(index), index));
        }
        return htmls;
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
                : Array.from({ length: prepared.blockCount }, (_unused, index) => this.renderBlockToHtml(prepared.blockAccess.getText(index), index));
            payload = this.buildFullPayload(prepared, options, htmls);
        } else {
            const insertedHtmls = this.getInsertedBlockIndices(prepared)
                .map(index => this.renderBlockToHtml(prepared.blockAccess.getText(index), index));

            this.commitRenderState(prepared);

            let dirtyBlocks: { [index: number]: string } | undefined;
            for (const [index, text] of this.getDirtyBlockRenderJobs(prepared.dirtyBlockIndices)) {
                dirtyBlocks ??= {};
                dirtyBlocks[index] = this.renderBlockToHtml(text, index);
            }

            payload = this.buildPatchPayload(prepared, insertedHtmls, dirtyBlocks);
        }

        this.protector.reset();

        return payload;
    }

    public async renderAsync(doc: RenderDocumentView, options: RenderOptions = {}): Promise<RenderPayload> {
        const prepared = this.prepareRenderState(doc, options);
        let payload: RenderPayload;

        if (prepared.isFullUpdate) {
            this.commitRenderState(prepared);
            const htmls = options.deferFullHtml
                ? undefined
                : await this.renderAllBlocksAsync(prepared);
            payload = this.buildFullPayload(prepared, options, htmls);
        } else {
            const insertedHtmls: string[] = [];
            for (const index of this.getInsertedBlockIndices(prepared)) {
                insertedHtmls.push(await this.renderBlockToHtmlAsync(prepared.blockAccess.getText(index), index));
            }

            this.commitRenderState(prepared);

            let dirtyBlocks: { [index: number]: string } | undefined;
            for (const [index, text] of this.getDirtyBlockRenderJobs(prepared.dirtyBlockIndices)) {
                dirtyBlocks ??= {};
                dirtyBlocks[index] = await this.renderBlockToHtmlAsync(text, index);
            }

            payload = this.buildPatchPayload(prepared, insertedHtmls, dirtyBlocks);
        }

        this.protector.reset();
        return payload;
    }

    public getPreviewSyncData(filePath: string, line: number, character?: number) {
        if (!this.documentView) {return null;}
        const flatLine = this.documentView.getFlattenedLine(filePath, line);
        return flatLine !== -1 ? this.getBlockIndexByLine(flatLine, character) : null;
    }

    public getSourceSyncData(blockIndex: number, ratio: number, anchors: readonly string[] = [], sourceStart?: number, sourceEnd?: number): SourceLocation | null {
        if (!this.documentView) {return null;}
        const flatLine = this.getLineByBlockIndex(blockIndex, ratio, anchors, sourceStart, sourceEnd);
        const sourceLoc = this.documentView.getOriginalPosition(flatLine);
        if (!sourceLoc) { return null; }

        const block = this.blockMap[blockIndex];
        if (!block) { return sourceLoc; }

        const startLoc = this.documentView.getOriginalPosition(block.start);
        const endLoc = this.documentView.getOriginalPosition(block.start + Math.max(0, block.count - 1));
        if (startLoc && endLoc && startLoc.file === sourceLoc.file && endLoc.file === sourceLoc.file) {
            return {
                ...sourceLoc,
                blockRange: {
                    startLine: Math.min(startLoc.line, endLoc.line),
                    endLine: Math.max(startLoc.line, endLoc.line)
                }
            };
        }
        return sourceLoc;
    }

    private getBlockIndexByLine(line: number, character?: number): { index: number; ratio: number; sourceStart?: number; sourceEnd?: number } {
        if (this.blockMap.length === 0) { return { index: 0, ratio: 0 }; }
        if (line < this.blockMap[0].start) { return { index: 0, ratio: 0 }; }
        for (let i = 0; i < this.blockMap.length; i++) {
            const b = this.blockMap[i];
            const nextStart = (i + 1 < this.blockMap.length) ? this.blockMap[i+1].start : Infinity;
            if (line >= b.start && line < nextStart) {
                const anchor = this.getAstPreviewAnchor(i, line - b.start, character);
                return anchor
                    ? { index: i, ...anchor }
                    : { index: i, ratio: Math.max(0, Math.min(1, (line - b.start) / Math.max(1, b.count))) };
            }
        }
        return { index: this.blockMap.length - 1, ratio: 0 };
    }

    private getLineByBlockIndex(index: number, ratio: number, anchors: readonly string[] = [], sourceStart?: number, sourceEnd?: number): number {
        const astHintLine = this.getLineBySourceOffset(index, sourceStart, sourceEnd) ?? this.getLineByAstSourceHint(index, ratio);
        const estimatedLine = astHintLine ?? this.getLineByBlockRatio(index, ratio);
        return this.refineLineByAnchors(index, estimatedLine, anchors) ?? estimatedLine;
    }

    private getLineBySourceOffset(index: number, sourceStart: number | undefined, sourceEnd: number | undefined): number | undefined {
        if (sourceStart === undefined) { return undefined; }

        const block = this.blockMap[index];
        const text = this.getSnapshotBlockText(this.lastTextSnapshot, index);
        if (!block || !text) { return undefined; }

        const targetOffset = sourceEnd === undefined
            ? sourceStart
            : Math.floor((sourceStart + sourceEnd) / 2);
        return block.start + lineAtOffset(text, Math.max(0, Math.min(text.length, targetOffset)));
    }

    private getLineByBlockRatio(index: number, ratio: number): number {
        if (index >= 0 && index < this.blockMap.length) {
            const block = this.blockMap[index];
            return block.start + Math.floor(block.count * ratio);
        }
        return 0;
    }

    private refineLineByAnchors(index: number, estimatedFlatLine: number, anchors: readonly string[]): number | undefined {
        if (anchors.length === 0) { return undefined; }

        const block = this.blockMap[index];
        const text = this.getSnapshotBlockText(this.lastTextSnapshot, index);
        if (!block || !text) { return undefined; }

        const lines = text.split(/\r?\n/);
        const estimatedLineInBlock = Math.max(0, Math.min(block.count - 1, estimatedFlatLine - block.start));
        const matchedLine = findNearestSyncAnchorLine(
            anchors,
            0,
            Math.min(lines.length - 1, Math.max(0, block.count - 1)),
            estimatedLineInBlock,
            line => lines[line] ?? ''
        );
        return matchedLine === undefined ? undefined : block.start + matchedLine;
    }

    private getAstSyncData(index: number): { block: { start: number; count: number }; artifact: AstBlockArtifact; text: string } | undefined {
        const block = this.blockMap[index];
        const artifact = this.documentView?.getAstBlockArtifact(index);
        const text = this.getSnapshotBlockText(this.lastTextSnapshot, index);
        if (!block || !artifact || !text || artifact.sourceHints.starts.length === 0) {
            return undefined;
        }
        return { block, artifact, text };
    }

    private getAstPreviewAnchor(index: number, lineInBlock: number, character?: number): { ratio: number; sourceStart: number; sourceEnd: number } | undefined {
        if (character === undefined) { return undefined; }

        const syncData = this.getAstSyncData(index);
        if (!syncData) { return undefined; }
        const { block, artifact, text } = syncData;

        const sourceOffset = offsetAtLine(text, lineInBlock) + Math.max(0, character);
        for (let hintIndex = 0; hintIndex < artifact.sourceHints.starts.length; hintIndex++) {
            const kind = artifact.sourceHints.kinds[hintIndex];
            if (!SOURCE_SYNC_HINT_KINDS.has(kind)) { continue; }

            const start = artifact.sourceHints.starts[hintIndex];
            const end = artifact.sourceHints.ends[hintIndex];
            if (sourceOffset >= start && sourceOffset <= end) {
                const hintLine = lineAtOffset(text, Math.floor((start + end) / 2));
                return {
                    ratio: Math.max(0, Math.min(1, hintLine / Math.max(1, block.count))),
                    sourceStart: start,
                    sourceEnd: end
                };
            }
        }
        return undefined;
    }

    private getLineByAstSourceHint(index: number, ratio: number): number | undefined {
        const syncData = this.getAstSyncData(index);
        if (!syncData) { return undefined; }
        const { block, artifact, text } = syncData;

        const estimatedLineInBlock = Math.max(0, Math.min(block.count - 1, Math.floor(block.count * ratio)));
        const estimatedOffset = offsetAtLine(text, estimatedLineInBlock);
        const threshold = Math.max(80, Math.floor(text.length * 0.08));
        let bestIndex = -1;
        let bestDistance = Infinity;

        for (let hintIndex = 0; hintIndex < artifact.sourceHints.starts.length; hintIndex++) {
            const kind = artifact.sourceHints.kinds[hintIndex];
            if (!SOURCE_SYNC_HINT_KINDS.has(kind)) { continue; }

            const start = artifact.sourceHints.starts[hintIndex];
            const end = artifact.sourceHints.ends[hintIndex];
            const hintLine = lineAtOffset(text, start);
            if (Math.abs(hintLine - estimatedLineInBlock) > 3) { continue; }

            const distance = estimatedOffset >= start && estimatedOffset <= end
                ? 0
                : Math.min(Math.abs(estimatedOffset - start), Math.abs(estimatedOffset - end));
            if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = hintIndex;
            }
        }

        if (bestIndex === -1 || bestDistance > threshold) {
            return undefined;
        }

        const start = artifact.sourceHints.starts[bestIndex];
        const end = artifact.sourceHints.ends[bestIndex];
        const targetOffset = Math.max(start, Math.min(end, estimatedOffset));
        return block.start + lineAtOffset(text, targetOffset);
    }
}
