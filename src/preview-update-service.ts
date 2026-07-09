import { LatexDocument, type DocumentParseResult } from './document';
import type { IFileProvider } from './file-provider';
import { SmartRenderer } from './renderer';
import { SNAP_TEX_RULES } from './rules';
import type { DocumentDiagnostic, RenderPayload, BackendMode, UriLike, RuleRegistry } from './types';

export interface PreviewRenderOptions {
    deferFullHtml: boolean;
    backendMode?: BackendMode;
    resetPreviewState?: boolean;
    trace?: (label: string) => void;
    transformHtml?: (html: string) => string;
}

/**
 * Coordinates document parsing and renderer state without depending on a host UI.
 */
export class PreviewUpdateService<TUri extends UriLike = UriLike> {
    private readonly document: LatexDocument<TUri>;
    private readonly renderer: SmartRenderer;
    private diagnostics: DocumentDiagnostic[] = [];
    private backendMode: BackendMode = 'legacy';

    constructor(fileProvider: IFileProvider<TUri>, registry: RuleRegistry = SNAP_TEX_RULES) {
        this.renderer = new SmartRenderer(registry);
        this.document = new LatexDocument(fileProvider, registry);
    }

    public resetState() {
        this.renderer.resetState();
        this.document.cancelAstArtifactWarmup();
        this.diagnostics = [];
    }

    private isAstBackend() {
        return this.backendMode === 'ast(experimental)';
    }

    public async renderBlockByIndex(index: number) {
        return this.isAstBackend()
            ? this.renderer.renderBlockByIndexAsync(index)
            : this.renderer.renderBlockByIndex(index);
    }

    public getDiagnostics(): readonly DocumentDiagnostic[] {
        return this.diagnostics;
    }

    public getPreviewSyncData(filePath: string, line: number, character?: number) {
        return this.renderer.getPreviewSyncData(filePath, line, character);
    }

    public getSourceSyncData(blockIndex: number, ratio: number, anchors: readonly string[] = [], sourceStart?: number, sourceEnd?: number) {
        return this.renderer.getSourceSyncData(blockIndex, ratio, anchors, sourceStart, sourceEnd);
    }

    public isKnownFile(uriStr: string): boolean {
        return this.renderer.isKnownFile(uriStr);
    }

    public getBibliographyKeys(): string[] {
        return [...this.document.bibEntries.keys()].sort((a, b) => a.localeCompare(b));
    }

    public getMacroNames(): string[] {
        return Object.keys(this.document.metadata.macros).sort((a, b) => a.localeCompare(b));
    }

    public async render(uri: TUri, text: string, options: PreviewRenderOptions): Promise<RenderPayload> {
        const backendMode = options.backendMode ?? 'legacy';
        const useAstBackend = backendMode === 'ast(experimental)';
        const backendModeChanged = backendMode !== this.backendMode;
        if (backendModeChanged) {
            this.backendMode = backendMode;
            this.resetState();
        }

        const parseResult = await this.document.parse(uri, text, {
            trace: options.trace,
            backendMode
        });
        this.diagnostics = parseResult.diagnostics;
        options.trace?.('after parse');

        this.document.applyResult(parseResult);
        const renderOptions = {
            deferFullHtml: options.deferFullHtml,
            resetPreviewState: backendModeChanged || options.resetPreviewState
        };
        const payload = useAstBackend
            ? await this.renderer.renderAsync(this.document, renderOptions)
            : this.renderer.render(this.document, renderOptions);
        options.trace?.('after render');

        if (useAstBackend) {
            const priorityIndices = this.getPatchRenderedBlockIndices(payload);
            if (priorityIndices.length > 0) {
                await this.document.warmAstBlockArtifactsForIndices(priorityIndices);
                options.trace?.('after priority ast warmup');
            }
            // Sync consumes existing AST hints only; start warm-up before
            // releasing transient parse text so updates can populate them.
            void this.document.warmAstBlockArtifacts();
        }

        this.releaseParseText(parseResult);
        this.transformPayloadHtml(payload, options.transformHtml);
        if (options.transformHtml) {
            options.trace?.('after transformHtml');
        }

        return payload;
    }

    private getPatchRenderedBlockIndices(payload: RenderPayload): number[] {
        if (payload.type !== 'patch') { return []; }
        const indices = Array.from(
            { length: payload.htmls.length },
            (_unused, offset) => payload.start + offset
        );
        if (payload.dirtyBlocks) {
            indices.push(...Object.keys(payload.dirtyBlocks).map(Number));
        }
        return [...new Set(indices)].sort((a, b) => a - b);
    }

    private releaseParseText(parseResult: DocumentParseResult) {
        this.document.releaseTextContent();
        parseResult.bodyText = "";
        parseResult.blockSpans = [];
        parseResult.blockHashes = [];
        parseResult.astBlockArtifacts = [];
    }

    private transformPayloadHtml(payload: RenderPayload, transformHtml: ((html: string) => string) | undefined) {
        if (!transformHtml) { return; }
        if (payload.dirtyBlocks) {
            for (const [index, html] of Object.entries(payload.dirtyBlocks)) {
                payload.dirtyBlocks[Number(index)] = transformHtml(html);
            }
        }
        if (payload.htmls) {
            for (let index = 0; index < payload.htmls.length; index++) {
                payload.htmls[index] = transformHtml(payload.htmls[index]);
            }
        }
    }
}
