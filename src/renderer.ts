import MarkdownIt from 'markdown-it';

import { DiffEngine, DiffResult } from './diff';
import { BlockNumberingCounts, BlockTextSnapshot, DependencyHelpers, DependencyState, NumberingPayload, RenderContext, RenderDependency, RenderedBlockMeta, RenderDocumentView, RenderOptions, RenderPayload, RuleRegistry, SourceLocation } from './types';
import { SNAP_TEX_RULES, postProcessHtml } from './rules';
import { LatexCounterScanner } from './scanner';
import { R_BIBLIOGRAPHY, R_THEBIBLIOGRAPHY } from './patterns';
import { extractLatexCitationKeys, extractLatexLabelNames, normalizeUri, stableHash } from './utils';
import { ProtectionManager } from './protection';

const EMPTY_TEXT_SNAPSHOT: BlockTextSnapshot = { bodyText: "", blockSpans: [] };

interface BlockSnapshot extends RenderedBlockMeta {
    hasBibliography: boolean;
    citationKeys: string[];
    dependencyFingerprint?: string;
}

/**
 * Converts a render document view into either a full render payload or a patch.
 *
 * SmartRenderer owns the preview-side document model snapshot: block hashes,
 * source-line mapping, label numbering, citation state, and the Markdown
 * protection pass. It is deliberately stateless with respect to VS Code APIs;
 * panel.ts handles I/O and webview transport.
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

    private getSnapshotBlockText(snapshot: BlockTextSnapshot, index: number): string | undefined {
        const span = snapshot.blockSpans[index];
        if (!span) { return undefined; }
        return snapshot.bodyText.slice(span.start, span.end);
    }

    private createRenderBlockAccess(doc: RenderDocumentView, blockCount: number) {
        const textCache = new Map<number, string>();
        const getText = (index: number): string => {
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
            hashBlocks: Array.from({ length: blockCount }, (_unused, index) => ({ hash: getHash(index) })),
            provider: {
                getBlockCount: () => blockCount,
                getBlockText: getText,
                getBlockHash: getHash
            }
        };
    }

    private buildBlockMeta(text: string, index: number): BlockSnapshot {
        const map = this.blockMap[index];
        return {
            index,
            hash: stableHash(text),
            line: map?.start ?? 0,
            lineCount: map?.count ?? text.split(/\r?\n/).length,
            anchors: Array.from(new Set(extractLatexLabelNames(text))),
            hasBibliography: R_BIBLIOGRAPHY.test(text) || R_THEBIBLIOGRAPHY.test(text),
            citationKeys: extractLatexCitationKeys(text)
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

    private buildNextBlockSnapshots(blockCount: number, diff: DiffResult, getBlockText: (index: number) => string): BlockSnapshot[] {
        const createBlockMeta = (index: number) => this.buildBlockMeta(getBlockText(index), index);
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

    private collectBlockDependencies(text: string, index: number): RenderDependency[] {
        return this.registry.blockDependencyRules.flatMap(rule => rule.collect({ text, index, deps: this.dependencyHelpers }));
    }

    private updateDependencySummaries(
        blockCount: number,
        diff: DiffResult,
        getBlockText: (index: number) => string
    ): Array<RenderDependency[] | undefined> {
        this.dependencySummaries = DiffEngine.rebuildArray(
            this.dependencySummaries,
            blockCount,
            diff,
            index => {
                const dependencies = this.collectBlockDependencies(getBlockText(index), index);
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

    /**
     * Renders a parsed document and returns the minimal webview update payload.
     *
     * The full-update threshold intentionally remains a fixed 50 changed blocks.
     * Virtual mode may request metadata-only full payloads; individual block HTML
     * is then rendered lazily by index from lastTextSnapshot.
     */
    public render(doc: RenderDocumentView, options: RenderOptions = {}): RenderPayload {
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

        const scanResult = this.scanner.scan(blockAccess.provider);

        const numberingData = this.buildNumberingPayload(scanResult);

        const diff = DiffEngine.compute(this.lastBlocks, blockAccess.hashBlocks);

        const isFullUpdate = this.lastBlocks.length === 0 || diff.insertCount > 50 || diff.deleteCount > 50;
        let payload: RenderPayload;
        let blockMeta = this.buildNextBlockSnapshots(blockCount, diff, blockAccess.getText);
        const nextCitedKeys = this.collectCitedKeys(blockMeta);
        this._citedKeys = nextCitedKeys;
        blockMeta = this.applyBibliographyAnchors(blockMeta, nextCitedKeys);
        const previousAlignedBlocks = blockMeta;
        const dependencySummaries = this.updateDependencySummaries(blockCount, diff, blockAccess.getText);
        blockMeta = this.applyDependencyFingerprints(blockMeta, dependencySummaries, {
            metadata: doc.metadata,
            citedKeysFingerprint: this.fingerprintCitedKeySet(nextCitedKeys)
        });
        const dirtyBlockIndices = this.collectDependencyDirtyBlockIndices(previousAlignedBlocks, blockMeta, diff);
        const nextTextSnapshot = doc.createTextSnapshot();

        if (isFullUpdate) {
            this.lastBlocks = blockMeta;
            this.lastTextSnapshot = nextTextSnapshot;

            payload = options.deferFullHtml
                ? {
                    type: 'full',
                    blocks: blockMeta,
                    numbering: numberingData
                }
                : {
                    type: 'full',
                    htmls: Array.from({ length: blockCount }, (_unused, index) => this.renderBlockToHtml(blockAccess.getText(index), index)),
                    preserveUnchangedBlocks: !macrosChanged,
                    numbering: numberingData
                };
        } else {
            const insertedHtmls: string[] = [];
            for (let i = 0; i < diff.insertCount; i++) {
                const absoluteIndex = diff.start + i;
                insertedHtmls.push(this.renderBlockToHtml(blockAccess.getText(absoluteIndex), absoluteIndex));
            }

            let shift = 0;
            if (diff.end > 0 && insertedHtmls.length !== diff.deleteCount) {
                shift = insertedHtmls.length - diff.deleteCount;
            }

            this.lastBlocks = blockMeta;
            this.lastTextSnapshot = nextTextSnapshot;

            let dirtyBlocks: { [index: number]: string } | undefined;
            for (const index of dirtyBlockIndices) {
                const text = this.getSnapshotBlockText(this.lastTextSnapshot, index);
                if (text !== undefined) {
                    dirtyBlocks ??= {};
                    dirtyBlocks[index] = this.renderBlockToHtml(text, index);
                }
            }

            payload = {
                type: 'patch',
                start: diff.start,
                deleteCount: diff.deleteCount,
                htmls: insertedHtmls,
                shift,
                numbering: numberingData,
                dirtyBlocks
            };
        }

        this.protector.reset();

        return payload;
    }

    public getPreviewSyncData(filePath: string, line: number) {
        if (!this.documentView) {return null;}
        const flatLine = this.documentView.getFlattenedLine(filePath, line);
        return flatLine !== -1 ? this.getBlockIndexByLine(flatLine) : null;
    }

    public getSourceSyncData(blockIndex: number, ratio: number): SourceLocation | null {
        if (!this.documentView) {return null;}
        const flatLine = this.getLineByBlockIndex(blockIndex, ratio);
        return this.documentView.getOriginalPosition(flatLine) || null;
    }

    private getBlockIndexByLine(line: number): { index: number; ratio: number } {
        if (this.blockMap.length === 0) { return { index: 0, ratio: 0 }; }
        if (line < this.blockMap[0].start) { return { index: 0, ratio: 0 }; }
        for (let i = 0; i < this.blockMap.length; i++) {
            const b = this.blockMap[i];
            const nextStart = (i + 1 < this.blockMap.length) ? this.blockMap[i+1].start : Infinity;
            if (line >= b.start && line < nextStart) {
                const ratio = Math.max(0, Math.min(1, (line - b.start) / Math.max(1, b.count)));
                return { index: i, ratio };
            }
        }
        return { index: this.blockMap.length - 1, ratio: 0 };
    }

    private getLineByBlockIndex(index: number, ratio: number): number {
        if (index >= 0 && index < this.blockMap.length) {
            const b = this.blockMap[index];
            return b.start + Math.floor(b.count * ratio);
        }
        return 0;
    }
}
