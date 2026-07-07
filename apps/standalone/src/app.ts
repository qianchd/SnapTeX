import { basicSetup, EditorView } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { BrowserFileProvider, BrowserUri, normalizeBrowserPath, type BrowserProjectFile } from './browser-file-provider';
import { createLatexEditorExtensions, type LatexCompletionData } from './editor-assistance';
import { PreviewUpdateService } from '../../../src/preview-update-service';
import { SmartRenderer } from '../../../src/renderer';
import { decodeHtmlAttribute, escapeHtmlAttribute, findNearestSyncAnchorLine, getSyncAnchorContext } from '../../../src/utils';
import { HostToPreviewCommand, PreviewToHostCommand, type HostToPreviewMessage, type PreviewToHostMessage } from '../../../src/preview-messages';

declare global {
    interface Window {
        snaptexStandaloneHost?: StandaloneHost;
        snaptexPreviewMessageQueue?: PreviewToHostMessage[];
    }
}

export interface StandaloneAppOptions {
    editorParent: HTMLElement;
    initialText: string;
    rootPath?: string;
    settings?: Partial<StandalonePreviewSettings>;
    onStateChange?: (host: StandaloneHost) => void;
}

export interface StandaloneSaveResult {
    path: string;
    text: string;
    wroteToSource: boolean;
}

export interface StandalonePreviewSettings {
    livePreview: boolean;
    autoScrollSync: boolean;
    renderDelayMs: number;
    autoScrollDelayMs: number;
    virtualMode: boolean;
    debugMemory: boolean;
}

export const DEFAULT_STANDALONE_PREVIEW_SETTINGS: StandalonePreviewSettings = {
    livePreview: true,
    autoScrollSync: true,
    renderDelayMs: 150,
    autoScrollDelayMs: 100,
    virtualMode: true,
    debugMemory: false
};

function debounce(callback: () => void, delayMs: number | (() => number)): () => void {
    let timer: number | undefined;
    return () => {
        if (timer !== undefined) {
            window.clearTimeout(timer);
        }
        timer = window.setTimeout(callback, typeof delayMs === 'function' ? delayMs() : delayMs);
    };
}

function lineAt(text: string, line: number): string {
    return text.split(/\r?\n/)[line] ?? '';
}

function lineStartOffset(text: string, line: number): number {
    if (line <= 0) { return 0; }
    let offset = 0;
    for (let index = 0; index < line; index++) {
        const next = text.indexOf('\n', offset);
        if (next === -1) { return text.length; }
        offset = next + 1;
    }
    return offset;
}

function normalizeEditorText(text: string): string {
    return text.replace(/\r\n?/g, '\n');
}

/**
 * Shared browser/WebView host for the standalone SnapTeX preview.
 */
export class StandaloneHost {
    private rootUri: BrowserUri;
    private activeUri: BrowserUri;
    private readonly fileProvider = new BrowserFileProvider();
    private readonly updateService = new PreviewUpdateService(this.fileProvider, new SmartRenderer());
    private readonly savedTexts = new Map<string, string>();
    private readonly dirtyPaths = new Set<string>();
    private readonly diagnostics = new Set<string>();
    private projectPaths: string[] = [];
    private labels: string[] = [];
    private previewReady = false;
    private programmaticEditorText: string | undefined;
    private suppressNextSelectionSync = false;
    private suppressEditorToPreviewUntil = 0;
    private settings: StandalonePreviewSettings;

    constructor(
        private readonly editorView: EditorView,
        rootPath: string = '/main.tex',
        private readonly scheduleRender: () => void = () => undefined,
        private readonly onStateChange: () => void = () => undefined,
        settings: Partial<StandalonePreviewSettings> = {}
    ) {
        this.rootUri = new BrowserUri(rootPath);
        this.activeUri = this.rootUri;
        this.settings = { ...DEFAULT_STANDALONE_PREVIEW_SETTINGS, ...settings };
    }

    start() {
        window.snaptexStandaloneHost = this;
        const queued = window.snaptexPreviewMessageQueue ?? [];
        window.snaptexPreviewMessageQueue = [];
        queued.forEach(message => this.handlePreviewMessage(message));
    }

    async loadProject(files: readonly BrowserProjectFile[], rootPath: string) {
        this.fileProvider.setProjectFiles(files);
        this.projectPaths = files.map(file => normalizeBrowserPath(file.path)).sort((a, b) => a.localeCompare(b));
        this.labels = [];
        this.savedTexts.clear();
        this.dirtyPaths.clear();
        this.rootUri = new BrowserUri(rootPath);
        this.activeUri = this.rootUri;
        const text = await this.fileProvider.read(this.activeUri);
        this.markSaved(this.activeUri.path, text);
        this.replaceEditorText(text);
        this.updateService.resetState();
        this.notifyStateChanged();
        await this.renderCurrentText();
    }

    async openEditorFile(path: string) {
        this.persistActiveEditorText();
        this.activeUri = new BrowserUri(path);
        const text = await this.fileProvider.read(this.activeUri);
        if (!this.savedTexts.has(this.activeUri.path)) {
            this.markSaved(this.activeUri.path, text);
        }
        this.replaceEditorText(text);
        this.notifyStateChanged();
        await this.renderCurrentText();
    }

    async setPreviewRoot(path: string) {
        this.persistActiveEditorText();
        this.rootUri = new BrowserUri(path);
        this.updateService.resetState();
        await this.renderCurrentText();
    }

    getRootPath(): string {
        return this.rootUri.path;
    }

    getActivePath(): string {
        return this.activeUri.path;
    }

    isDirty(path: string): boolean {
        return this.dirtyPaths.has(new BrowserUri(path).path);
    }

    getDiagnostics(): readonly string[] {
        return [...this.diagnostics];
    }

    getSettings(): StandalonePreviewSettings {
        return { ...this.settings };
    }

    updateSettings(settings: Partial<StandalonePreviewSettings>) {
        const previousVirtualMode = this.settings.virtualMode;
        const previousLivePreview = this.settings.livePreview;
        this.settings = { ...this.settings, ...settings };
        if (this.previewReady) {
            this.postPreviewConfig();
            if (previousVirtualMode !== this.settings.virtualMode) {
                this.updateService.resetState();
            }
            if (previousVirtualMode !== this.settings.virtualMode || (!previousLivePreview && this.settings.livePreview)) {
                void this.renderCurrentText();
            }
        }
        this.notifyStateChanged();
    }

    getLatexCompletionData(): LatexCompletionData {
        return {
            labels: this.labels,
            citationKeys: this.updateService.getBibliographyKeys(),
            projectPaths: this.projectPaths,
            macros: this.updateService.getMacroNames()
        };
    }

    private replaceEditorText(text: string) {
        const editorText = normalizeEditorText(text);
        if (this.editorView.state.doc.toString() === editorText) {
            this.programmaticEditorText = undefined;
            return;
        }
        this.programmaticEditorText = editorText;
        this.editorView.dispatch({
            changes: { from: 0, to: this.editorView.state.doc.length, insert: editorText }
        });
    }

    private persistActiveEditorText() {
        const text = this.editorView.state.doc.toString();
        this.fileProvider.setFile(this.activeUri, text);
        this.updateDirtyState(this.activeUri.path, text);
    }

    private markSaved(path: string, text: string) {
        this.savedTexts.set(path, normalizeEditorText(text));
        this.updateDirtyState(path, text);
    }

    private updateDirtyState(path: string, text: string) {
        const wasDirty = this.dirtyPaths.has(path);
        const savedText = this.savedTexts.get(path);
        const isDirty = savedText !== undefined && normalizeEditorText(text) !== savedText;
        if (isDirty) {
            this.dirtyPaths.add(path);
        } else {
            this.dirtyPaths.delete(path);
        }
        if (wasDirty !== isDirty) {
            this.notifyStateChanged();
        }
    }

    private notifyStateChanged() {
        this.onStateChange();
    }

    async saveCurrentText(): Promise<StandaloneSaveResult> {
        const text = this.editorView.state.doc.toString();
        const wroteToSource = await this.fileProvider.write(this.activeUri, text);
        this.markSaved(this.activeUri.path, text);
        return {
            path: this.activeUri.path,
            text,
            wroteToSource
        };
    }

    syncEditorSelection(line: number, character = 0, lineText?: string, viewRatio = 0.5, auto = true) {
        if (auto && !this.settings.autoScrollSync) {
            return;
        }
        if (!this.previewReady) {
            return;
        }

        const syncData = this.updateService.getPreviewSyncData(this.activeUri.toString(), line);
        if (!syncData) {
            return;
        }

        this.postToPreview({
            command: HostToPreviewCommand.ScrollToBlock,
            index: syncData.index,
            ratio: syncData.ratio,
            anchor: getSyncAnchorContext(lineText ?? lineAt(this.editorView.state.doc.toString(), line), character),
            auto,
            viewRatio
        });
    }

    shouldSuppressEditorToPreview(): boolean {
        return Date.now() < this.suppressEditorToPreviewUntil;
    }

    private suppressEditorToPreview(durationMs = 500) {
        this.suppressEditorToPreviewUntil = Math.max(this.suppressEditorToPreviewUntil, Date.now() + durationMs);
    }

    consumeSelectionSyncSuppression(): boolean {
        const suppressed = this.suppressNextSelectionSync;
        this.suppressNextSelectionSync = false;
        return suppressed;
    }

    private async openSourceForPreview(index: number, ratio: number) {
        const source = this.updateService.getSourceSyncData(index, ratio);
        if (!source) {
            return undefined;
        }

        const targetPath = normalizeBrowserPath(source.file);
        if (targetPath !== this.activeUri.path) {
            await this.openEditorFile(targetPath);
        }

        return {
            source,
            text: this.editorView.state.doc.toString()
        };
    }

    async revealPreviewLocation(index: number, ratio: number, anchors: readonly string[] = [], viewRatio = 0.5) {
        const target = await this.openSourceForPreview(index, ratio);
        if (!target) {
            return;
        }

        const { source, text } = target;
        let targetLine = source.line;
        if (anchors.length > 0) {
            const lines = text.split(/\r?\n/);
            const startLine = Math.max(0, source.blockRange?.startLine ?? targetLine - 5);
            const endLine = Math.min(lines.length - 1, source.blockRange?.endLine ?? targetLine + 10);
            targetLine = findNearestSyncAnchorLine(anchors, startLine, endLine, targetLine, line => lines[line] ?? '') ?? targetLine;
        }

        const position = Math.min(this.editorView.state.doc.length, lineStartOffset(text, Math.max(0, targetLine)));
        this.suppressNextSelectionSync = true;
        this.suppressEditorToPreview();
        this.editorView.dispatch({
            selection: { anchor: position },
            effects: EditorView.scrollIntoView(position, { y: viewRatio < 0.35 ? 'start' : viewRatio > 0.65 ? 'end' : 'center' })
        });
    }

    async syncPreviewScroll(index: number, ratio: number) {
        if (!this.settings.autoScrollSync) {
            return;
        }

        const target = await this.openSourceForPreview(index, ratio);
        if (!target) {
            return;
        }

        const position = Math.min(this.editorView.state.doc.length, lineStartOffset(target.text, Math.max(0, target.source.line)));
        this.suppressEditorToPreview();
        this.editorView.dispatch({
            effects: EditorView.scrollIntoView(position, { y: 'center' })
        });
    }

    handleEditorUpdate() {
        const text = this.editorView.state.doc.toString();
        if (this.programmaticEditorText === text) {
            this.programmaticEditorText = undefined;
            return;
        }
        this.programmaticEditorText = undefined;
        this.persistActiveEditorText();
        if (this.settings.livePreview) {
            this.scheduleRender();
        }
    }

    handlePreviewMessage(message: PreviewToHostMessage) {
        switch (message.command) {
            case PreviewToHostCommand.PreviewLoaded:
                this.previewReady = true;
                this.postPreviewConfig();
                void this.renderCurrentText();
                break;
            case PreviewToHostCommand.RequestBlockHtml:
                this.handleBlockHtmlRequest(message.id, message.index, message.hash);
                break;
            case PreviewToHostCommand.RequestPdf:
                this.handlePdfRequest(message.id, message.path);
                break;
            case PreviewToHostCommand.RevealLine:
                void this.revealPreviewLocation(message.index, message.ratio, message.anchors ?? [], message.viewRatio);
                break;
            case PreviewToHostCommand.SyncScroll:
                void this.syncPreviewScroll(message.index, message.ratio);
                break;
        }
    }

    async renderCurrentText() {
        if (!this.previewReady) {
            return;
        }

        this.persistActiveEditorText();
        const rootText = await this.fileProvider.read(this.rootUri);
        const payload = await this.updateService.render(this.rootUri, rootText, {
            deferFullHtml: this.settings.virtualMode,
            transformHtml: html => this.fixHtmlPaths(html)
        });

        this.labels = Object.keys(payload.numbering.labels).sort((a, b) => a.localeCompare(b));
        this.replaceDiagnostics(this.updateService.getDiagnostics().map(diagnostic => diagnostic.message));
        this.postToPreview({ command: HostToPreviewCommand.Update, payload });
    }

    private handleBlockHtmlRequest(id: string, index: number, hash: string) {
        const rendered = this.updateService.renderBlockByIndex(index);
        this.postToPreview({
            command: HostToPreviewCommand.BlockHtml,
            id,
            index,
            hash: rendered?.hash ?? hash,
            html: rendered?.html === undefined ? undefined : this.fixHtmlPaths(rendered.html),
            error: rendered?.html ? undefined : 'Block HTML is unavailable.'
        });
    }

    private handlePdfRequest(id: string, path: string) {
        const pathText = decodeHtmlAttribute(path);
        if (!pathText.toLowerCase().endsWith('.pdf')) {
            this.postToPreview({ command: HostToPreviewCommand.PdfUri, id, error: 'Invalid PDF path' });
            return;
        }

        const uri = this.resolveProjectResourceUri(pathText);
        const url = this.fileProvider.getResourceUrl(uri);
        if (!url) {
            this.addDiagnostic(`Missing PDF: ${pathText}`);
        }
        this.postToPreview(url
            ? { command: HostToPreviewCommand.PdfUri, id, path: pathText, uri: url }
            : { command: HostToPreviewCommand.PdfUri, id, path: pathText, error: 'PDF not found' });
    }

    private fixHtmlPaths(html: string): string {
        return html.replace(/(src|data-pdf-src)="LOCAL_IMG:([^"]+)"/g, (_match, attr, relPath) => {
            const path = decodeHtmlAttribute(relPath);
            const url = this.fileProvider.getResourceUrl(this.resolveProjectResourceUri(path));
            if (!url) {
                this.addDiagnostic(`${attr === 'data-pdf-src' ? 'Missing PDF' : 'Missing image'}: ${path}`);
            }
            return url ? `${attr}="${escapeHtmlAttribute(url)}"` : `${attr}=""`;
        });
    }

    private resolveProjectResourceUri(relativePath: string): BrowserUri {
        return this.fileProvider.resolve(this.fileProvider.dir(this.rootUri), relativePath);
    }

    private postToPreview(message: HostToPreviewMessage) {
        window.postMessage(message, window.location.origin);
    }

    private postPreviewConfig() {
        this.postToPreview({
            command: HostToPreviewCommand.Config,
            config: {
                autoScrollDelay: this.settings.autoScrollDelayMs,
                debugMemory: this.settings.debugMemory,
                virtualMode: this.settings.virtualMode
            }
        });
    }

    private replaceDiagnostics(messages: readonly string[]) {
        const previous = this.getDiagnostics().join('\n');
        this.diagnostics.clear();
        messages.forEach(message => this.diagnostics.add(message));
        if (previous !== this.getDiagnostics().join('\n')) {
            this.notifyStateChanged();
        }
    }

    private addDiagnostic(message: string) {
        const size = this.diagnostics.size;
        this.diagnostics.add(message);
        if (this.diagnostics.size !== size) {
            this.notifyStateChanged();
        }
    }
}

export function createStandaloneSnapTeXApp(options: StandaloneAppOptions): StandaloneHost {
    let host: StandaloneHost | undefined;
    const scheduleRender = debounce(() => {
        void host?.renderCurrentText();
    }, () => host?.getSettings().renderDelayMs ?? DEFAULT_STANDALONE_PREVIEW_SETTINGS.renderDelayMs);
    let activeCursorScreenRatio = 0.5;
    let pendingSelection: { line: number; character: number; text: string; auto: boolean } | undefined;
    const scheduleSelectionSync = debounce(() => {
        if (pendingSelection && !host?.shouldSuppressEditorToPreview()) {
            host?.syncEditorSelection(
                pendingSelection.line,
                pendingSelection.character,
                pendingSelection.text,
                activeCursorScreenRatio,
                pendingSelection.auto
            );
        }
    }, () => host?.getSettings().autoScrollDelayMs ?? DEFAULT_STANDALONE_PREVIEW_SETTINGS.autoScrollDelayMs);

    const scheduleEditorSelectionSync = (view: EditorView, auto: boolean) => {
        if (host?.shouldSuppressEditorToPreview()) {
            pendingSelection = undefined;
            return;
        }
        const selection = view.state.selection.main;
        const line = view.state.doc.lineAt(selection.head);
        pendingSelection = {
            line: line.number - 1,
            character: selection.head - line.from,
            text: line.text,
            auto
        };
        scheduleSelectionSync();
    };

    const updateCursorScreenRatio = (view: EditorView) => {
        const selection = view.state.selection.main;
        const coords = view.coordsAtPos(selection.head);
        const rect = view.scrollDOM.getBoundingClientRect();
        if (!coords || rect.height <= 0) {
            return;
        }
        activeCursorScreenRatio = Math.max(0.1, Math.min(0.9, (coords.top - rect.top) / rect.height));
    };

    const scheduleEditorScrollSync = (view: EditorView) => {
        if (host?.shouldSuppressEditorToPreview()) {
            pendingSelection = undefined;
            return;
        }
        const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop + view.scrollDOM.clientHeight * activeCursorScreenRatio);
        const line = view.state.doc.lineAt(block.from);
        pendingSelection = {
            line: line.number - 1,
            character: 0,
            text: line.text,
            auto: true
        };
        scheduleSelectionSync();
    };

    const editorView = new EditorView({
        parent: options.editorParent,
        state: EditorState.create({
            doc: options.initialText,
            extensions: [
                basicSetup,
                keymap.of([
                    {
                        key: 'Ctrl-Alt-m',
                        mac: 'Cmd-Alt-m',
                        run(view) {
                            updateCursorScreenRatio(view);
                            scheduleEditorSelectionSync(view, false);
                            return true;
                        }
                    },
                    indentWithTab
                ]),
                EditorView.lineWrapping,
                createLatexEditorExtensions(() => host?.getLatexCompletionData() ?? {
                    labels: [],
                    citationKeys: [],
                    projectPaths: [],
                    macros: []
                }),
                EditorView.updateListener.of(update => {
                    if (update.docChanged) {
                        pendingSelection = undefined;
                        host?.handleEditorUpdate();
                    } else if (update.selectionSet) {
                        if (host?.consumeSelectionSyncSuppression()) {
                            pendingSelection = undefined;
                            return;
                        }
                        updateCursorScreenRatio(update.view);
                        scheduleEditorSelectionSync(update.view, true);
                    }
                }),
                EditorView.domEventHandlers({
                    scroll: (_event, view) => {
                        scheduleEditorScrollSync(view);
                    }
                })
            ]
        })
    });

    host = new StandaloneHost(editorView, options.rootPath, scheduleRender, () => {
        if (host) {
            options.onStateChange?.(host);
        }
    }, options.settings);
    host.start();
    return host;
}
