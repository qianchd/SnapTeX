import { basicSetup, EditorView } from 'codemirror';
import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, type DecorationSet, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { BrowserFileProvider, BrowserUri } from './browser-file-provider';
import { createLatexEditorExtensions, type LatexCompletionData } from './editor-assistance';
import { chooseRootPath, isProjectTextFile, normalizeBrowserPath, type BrowserProject, type BrowserProjectSnapshot } from './browser-project';
import { PreviewUpdateService } from '../../../src/preview-update-service';
import { DEFAULT_PREVIEW_LAYOUT, DEFAULT_PREVIEW_STYLE_SETTINGS, type BackendMode, type PreviewLayoutMode, type PreviewStyleSettings, type SourceSyncOptions } from '../../../src/types';
import { decodeHtmlAttribute, getSyncAnchorContext, offsetAtLine, replaceLocalResourceUrls } from '../../../src/utils';
import { HostToPreviewCommand, PreviewToHostCommand, type HostToPreviewMessage, type PreviewToHostMessage } from '../../../src/preview-messages';

declare global {
    interface Window {
        snaptexStandaloneHost?: StandaloneHost;
        snaptexPreviewMessageQueue?: PreviewToHostMessage[];
    }
}

type PreviewRevealOptions = SourceSyncOptions & { viewRatio?: number };

interface StandaloneAppOptions {
    editorParent: HTMLElement;
    initialText: string;
    rootPath?: string;
    settings?: Partial<StandalonePreviewSettings>;
    onStateChange?: (host: StandaloneHost) => void;
}

interface StandaloneSaveResult {
    path: string;
    text: string;
    wroteToSource: boolean;
}

export interface StandalonePreviewSettings extends PreviewStyleSettings {
    livePreview: boolean;
    autoScrollSync: boolean;
    renderDelayMs: number;
    autoScrollDelayMs: number;
    virtualMode: boolean;
    backendMode: BackendMode;
    previewLayout: PreviewLayoutMode;
    debugMemory: boolean;
}

export const DEFAULT_STANDALONE_PREVIEW_SETTINGS: StandalonePreviewSettings = {
    ...DEFAULT_PREVIEW_STYLE_SETTINGS,
    livePreview: true,
    autoScrollSync: true,
    renderDelayMs: 150,
    autoScrollDelayMs: 100,
    virtualMode: true,
    backendMode: 'legacy',
    previewLayout: DEFAULT_PREVIEW_LAYOUT,
    debugMemory: false
};

const flashEditorLineEffect = StateEffect.define<number | null>();
const flashEditorLineField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update: (decorations, transaction) => {
        for (const effect of transaction.effects) {
            if (!effect.is(flashEditorLineEffect)) { continue; }
            if (effect.value === null) { return Decoration.none; }
            const line = transaction.state.doc.lineAt(effect.value);
            return Decoration.set([Decoration.line({ class: 'snaptex-editor-jump-highlight' }).range(line.from)]);
        }
        return decorations.map(transaction.changes);
    },
    provide: field => EditorView.decorations.from(field)
});

function debounce(callback: () => void, delayMs: number | (() => number)): () => void {
    let timer: number | undefined;
    return () => {
        if (timer !== undefined) {
            window.clearTimeout(timer);
        }
        timer = window.setTimeout(() => {
            timer = undefined;
            callback();
        }, typeof delayMs === 'function' ? delayMs() : delayMs);
    };
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
    private readonly updateService = new PreviewUpdateService(this.fileProvider);
    private readonly savedTexts = new Map<string, string>();
    private readonly dirtyPaths = new Set<string>();
    private readonly diagnostics = new Set<string>();
    private projectOperations: BrowserProject['operations'];
    private setProjectActivePath: BrowserProject['setActivePath'];
    private setProjectRootPath: BrowserProject['setRootPath'];
    private projectName = 'SnapTeX Project';
    private projectAutosave = false;
    private autosaveTimer: number | undefined;
    private autosaveQueue: Promise<void> = Promise.resolve();
    private labels: string[] = [];
    private previewReady = false;
    private previewVisible = true;
    private programmaticEditorUpdate = false;
    private suppressNextSelectionSync = false;
    private suppressEditorToPreviewUntil = 0;
    private suppressPreviewToEditorUntil = 0;
    private editorFlashToken = 0;
    private settings: StandalonePreviewSettings;

    constructor(
        private readonly editorView: EditorView,
        rootPath: string = '/main.tex',
        private readonly scheduleRender: () => void = () => undefined,
        private readonly onStateChange: () => void = () => undefined,
        settings: Partial<StandalonePreviewSettings> = {},
        private readonly cancelPendingEditorSync: () => void = () => undefined
    ) {
        this.rootUri = new BrowserUri(rootPath);
        this.activeUri = this.rootUri;
        this.settings = { ...DEFAULT_STANDALONE_PREVIEW_SETTINGS, ...settings };
    }

    start() {
        window.snaptexStandaloneHost = this;
        const queued = window.snaptexPreviewMessageQueue ?? [];
        window.snaptexPreviewMessageQueue = [];
        queued.forEach(message => void this.handlePreviewMessage(message));
    }

    async loadProject(project: BrowserProject): Promise<string> {
        await this.flushProjectWrites();
        const rootPath = project.rootPath ?? chooseRootPath(project.files);
        if (!rootPath) {
            throw new Error('No TeX root file found.');
        }
        this.fileProvider.setProjectFiles(project.files);
        this.projectOperations = project.operations;
        this.projectAutosave = project.autosave === true;
        this.setProjectActivePath = project.setActivePath;
        this.setProjectRootPath = project.setRootPath;
        this.projectName = project.name ?? rootPath;
        this.labels = [];
        this.savedTexts.clear();
        this.dirtyPaths.clear();
        this.rootUri = new BrowserUri(rootPath);
        const activePath = project.activePath && this.fileProvider.has(project.activePath)
            ? project.activePath
            : rootPath;
        this.activeUri = new BrowserUri(activePath);
        const text = await this.fileProvider.read(this.activeUri);
        await this.setProjectActivePath?.(this.activeUri.path);
        this.markSaved(this.activeUri.path, text);
        this.replaceEditorText(text);
        this.updateService.resetState();
        this.notifyStateChanged();
        await this.renderCurrentText();
        return rootPath;
    }

    async openEditorFile(path: string) {
        await this.flushProjectWrites();
        this.persistActiveEditorText();
        this.activeUri = new BrowserUri(path);
        const text = await this.fileProvider.read(this.activeUri);
        await this.setProjectActivePath?.(this.activeUri.path);
        if (!this.savedTexts.has(this.activeUri.path)) {
            this.markSaved(this.activeUri.path, text);
        }
        this.replaceEditorText(text);
        this.notifyStateChanged();
        await this.renderCurrentText();
    }

    async setPreviewRoot(path: string) {
        await this.flushProjectWrites();
        this.persistActiveEditorText();
        this.rootUri = new BrowserUri(path);
        await this.setProjectRootPath?.(this.rootUri.path);
        this.updateService.resetState();
        this.notifyStateChanged();
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

    getProjectTextPaths(): readonly string[] {
        return this.fileProvider.getPaths().filter(isProjectTextFile);
    }

    canModifyProject(): boolean {
        return this.projectOperations !== undefined;
    }

    async createTextFile(path: string): Promise<void> {
        const normalizedPath = normalizeBrowserPath(path);
        if (!this.projectOperations) {
            throw new Error('This project does not support creating files.');
        }
        if (!isProjectTextFile(normalizedPath)) {
            throw new Error('SnapTeX can only create supported text files.');
        }
        if (this.fileProvider.has(normalizedPath)) {
            throw new Error(`File already exists: ${normalizedPath}`);
        }

        const file = await this.projectOperations.createTextFile(normalizedPath, '');
        this.fileProvider.setProjectFile({ ...file, path: normalizedPath });
        await this.openEditorFile(normalizedPath);
    }

    async deleteTextFile(path: string): Promise<void> {
        const normalizedPath = normalizeBrowserPath(path);
        if (!this.projectOperations) {
            throw new Error('This project does not support deleting files.');
        }
        if (!isProjectTextFile(normalizedPath) || !this.fileProvider.has(normalizedPath)) {
            throw new Error(`Project text file does not exist: ${normalizedPath}`);
        }
        if (normalizedPath === this.rootUri.path) {
            throw new Error('The preview root cannot be deleted. Set another root first.');
        }

        await this.projectOperations.deleteFile(normalizedPath);
        this.fileProvider.deleteProjectFile(normalizedPath);
        this.savedTexts.delete(normalizedPath);
        this.dirtyPaths.delete(normalizedPath);
        this.updateService.resetState();
        if (this.activeUri.path === normalizedPath) {
            this.activeUri = this.rootUri;
            this.replaceEditorText(await this.fileProvider.read(this.rootUri));
        }
        this.notifyStateChanged();
        await this.renderCurrentText();
    }

    getSettings(): StandalonePreviewSettings {
        return { ...this.settings };
    }

    updateSettings(settings: Partial<StandalonePreviewSettings>) {
        const previousVirtualMode = this.settings.virtualMode;
        const previousLivePreview = this.settings.livePreview;
        const previousBackendMode = this.settings.backendMode;
        this.settings = { ...this.settings, ...settings };
        if (this.previewReady) {
            this.postPreviewConfig();
            const backendModeChanged = previousBackendMode !== this.settings.backendMode;
            if (previousVirtualMode !== this.settings.virtualMode || backendModeChanged) {
                this.updateService.resetState();
            }
            if (previousVirtualMode !== this.settings.virtualMode || backendModeChanged || (!previousLivePreview && this.settings.livePreview)) {
                void this.renderCurrentText();
            }
        }
        this.notifyStateChanged();
    }

    getLatexCompletionData(): LatexCompletionData {
        return {
            labels: this.labels,
            citationKeys: this.updateService.getBibliographyKeys(),
            projectPaths: this.fileProvider.getPaths(),
            macros: this.updateService.getMacroNames()
        };
    }

    private replaceEditorText(text: string) {
        const editorText = normalizeEditorText(text);
        this.programmaticEditorUpdate = true;
        try {
            this.editorView.dispatch({
                changes: { from: 0, to: this.editorView.state.doc.length, insert: editorText },
                annotations: Transaction.addToHistory.of(false)
            });
        } finally {
            this.programmaticEditorUpdate = false;
        }
    }

    private persistActiveEditorText(text = this.editorView.state.doc.toString()) {
        this.fileProvider.setFile(this.activeUri, text);
        this.updateDirtyState(this.activeUri.path, text);
    }

    private async writeCurrentText(): Promise<StandaloneSaveResult> {
        const text = this.editorView.state.doc.toString();
        const path = this.activeUri.path;
        const wroteToSource = await this.fileProvider.write(this.activeUri, text);
        this.markSaved(path, text);
        return { path, text, wroteToSource };
    }

    private scheduleAutosave(): void {
        if (!this.projectAutosave) {
            return;
        }
        this.clearAutosaveTimer();
        this.autosaveTimer = window.setTimeout(() => {
            this.autosaveTimer = undefined;
            void this.queueAutosave().catch(error => this.addDiagnostic(`Autosave failed: ${error instanceof Error ? error.message : String(error)}`));
        }, 300);
    }

    private queueAutosave(): Promise<void> {
        const write = this.autosaveQueue.then(async () => {
            if (this.projectAutosave && !this.fileProvider.isEmpty()) {
                await this.writeCurrentText();
            }
        });
        this.autosaveQueue = write.catch(() => undefined);
        return write;
    }

    private clearAutosaveTimer(): void {
        if (this.autosaveTimer !== undefined) {
            window.clearTimeout(this.autosaveTimer);
            this.autosaveTimer = undefined;
        }
    }

    private markSaved(path: string, text: string) {
        const normalizedText = normalizeEditorText(text);
        this.savedTexts.set(path, normalizedText);
        this.updateDirtyState(path, normalizedText);
    }

    private updateDirtyState(path: string, text: string) {
        const wasDirty = this.dirtyPaths.has(path);
        const savedText = this.savedTexts.get(path);
        const isDirty = savedText !== undefined && text !== savedText;
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
        this.clearAutosaveTimer();
        await this.autosaveQueue;
        return this.writeCurrentText();
    }

    async flushProjectWrites(): Promise<void> {
        this.clearAutosaveTimer();
        if (this.projectAutosave) {
            await this.queueAutosave();
        }
    }

    async createProjectSnapshot(): Promise<BrowserProjectSnapshot> {
        await this.flushProjectWrites();
        return {
            name: this.projectName,
            files: await this.fileProvider.snapshot()
        };
    }

    syncEditorSelection(line: number, character = 0, lineText?: string, viewRatio = 0.5, auto = true) {
        if (this.shouldSuppressEditorToPreview() || (auto && !this.settings.autoScrollSync)) {
            return;
        }
        if (!this.previewReady) {
            return;
        }

        const syncData = this.updateService.getPreviewSyncData(this.activeUri.toString(), line, character);
        if (!syncData) {
            return;
        }

        const document = this.editorView.state.doc;
        const anchorText = lineText ?? document.line(Math.max(1, Math.min(document.lines, line + 1))).text;
        this.postToPreview({
            command: HostToPreviewCommand.ScrollToBlock,
            index: syncData.index,
            ratio: syncData.ratio,
            anchor: getSyncAnchorContext(anchorText, character),
            sourceStart: syncData.sourceStart,
            sourceEnd: syncData.sourceEnd,
            auto,
            viewRatio
        });
    }

    shouldSuppressEditorToPreview(): boolean {
        return !this.previewVisible || Date.now() < this.suppressEditorToPreviewUntil;
    }

    setPreviewVisible(visible: boolean): void {
        this.previewVisible = visible;
        if (!visible) {
            this.cancelPendingEditorSync();
        }
    }

    private suppressEditorToPreview(durationMs = 500) {
        this.suppressEditorToPreviewUntil = Math.max(this.suppressEditorToPreviewUntil, Date.now() + durationMs);
    }

    private scrollEditorPositionToViewRatio(position: number, viewRatio: number) {
        const clampedRatio = Math.max(0, Math.min(1, viewRatio));
        this.editorView.requestMeasure({
            key: this,
            read: view => ({
                lineTop: view.lineBlockAt(position).top,
                editorHeight: view.scrollDOM.clientHeight
            }),
            write: ({ lineTop, editorHeight }, view) => {
                view.scrollDOM.scrollTop = Math.max(0, lineTop - editorHeight * clampedRatio);
            }
        });
    }

    consumeSelectionSyncSuppression(): boolean {
        const suppressed = this.suppressNextSelectionSync;
        this.suppressNextSelectionSync = false;
        return suppressed;
    }

    private async openSourceForPreview(index: number, ratio: number, options: SourceSyncOptions = {}) {
        const source = this.updateService.getSourceSyncData(index, ratio, options);
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

    async revealPreviewLocation(index: number, ratio: number, options: PreviewRevealOptions = {}) {
        this.cancelPendingEditorSync();
        const target = await this.openSourceForPreview(index, ratio, options);
        if (!target) {
            return;
        }

        const { source, text } = target;
        const position = Math.min(this.editorView.state.doc.length, offsetAtLine(text, Math.max(0, source.line)));
        this.suppressNextSelectionSync = true;
        this.suppressEditorToPreview();
        this.editorView.dispatch({
            selection: { anchor: position },
            effects: flashEditorLineEffect.of(position)
        });
        this.scrollEditorPositionToViewRatio(position, options.viewRatio ?? 0.5);
        const token = ++this.editorFlashToken;
        globalThis.setTimeout(() => {
            if (token === this.editorFlashToken) {
                this.editorView.dispatch({ effects: flashEditorLineEffect.of(null) });
            }
        }, 1200);
    }

    async syncPreviewScroll(index: number, ratio: number, options: SourceSyncOptions = {}) {
        if (!this.settings.autoScrollSync || Date.now() < this.suppressPreviewToEditorUntil) {
            return;
        }

        this.cancelPendingEditorSync();
        const target = await this.openSourceForPreview(index, ratio, options);
        if (!target || Date.now() < this.suppressPreviewToEditorUntil) {
            return;
        }

        const position = Math.min(this.editorView.state.doc.length, offsetAtLine(target.text, Math.max(0, target.source.line)));
        this.suppressEditorToPreview();
        this.scrollEditorPositionToViewRatio(position, 0.5);
    }

    handleEditorUpdate() {
        if (this.programmaticEditorUpdate) { return; }
        const text = this.editorView.state.doc.toString();
        this.persistActiveEditorText(text);
        this.scheduleAutosave();
        if (this.settings.livePreview) {
            this.scheduleRender();
        }
    }

    async handlePreviewMessage(message: PreviewToHostMessage) {
        switch (message.command) {
            case PreviewToHostCommand.PreviewLoaded:
                this.previewReady = true;
                this.postPreviewConfig();
                void this.renderCurrentText();
                break;
            case PreviewToHostCommand.RequestBlockHtml:
                for (const request of message.requests) {
                    await this.handleBlockHtmlRequest(request.id, request.index, request.hash);
                }
                break;
            case PreviewToHostCommand.RequestPdf:
                await this.handlePdfRequest(message.id, message.path);
                break;
            case PreviewToHostCommand.RevealLine:
                void this.revealPreviewLocation(message.index, message.ratio, message);
                break;
            case PreviewToHostCommand.SyncScroll:
                void this.syncPreviewScroll(message.index, message.ratio, message);
                break;
            case PreviewToHostCommand.PreviewLayoutChanged: {
                const duration = Math.max(500, this.settings.autoScrollDelayMs + 300);
                this.suppressEditorToPreview(duration);
                this.suppressPreviewToEditorUntil = Math.max(this.suppressPreviewToEditorUntil, Date.now() + duration);
                break;
            }
        }
    }

    async renderCurrentText() {
        if (!this.previewReady || this.fileProvider.isEmpty()) {
            return;
        }

        this.persistActiveEditorText();
        const rootText = await this.fileProvider.read(this.rootUri);
        const payload = await this.updateService.render(this.rootUri, rootText, {
            deferFullHtml: this.settings.virtualMode,
            backendMode: this.settings.backendMode,
            transformHtml: html => this.fixHtmlPaths(html)
        });

        this.labels = Object.keys(payload.numbering.labels).sort((a, b) => a.localeCompare(b));
        this.replaceDiagnostics(this.updateService.getDiagnostics().map(diagnostic => diagnostic.message));
        this.postToPreview({ command: HostToPreviewCommand.Update, payload });
    }

    private async handleBlockHtmlRequest(id: string, index: number, hash: string) {
        const rendered = await this.updateService.renderBlockByIndex(index);
        this.postToPreview({
            command: HostToPreviewCommand.BlockHtml,
            id,
            index,
            hash: rendered?.hash ?? hash,
            html: rendered?.html === undefined ? undefined : await this.fixHtmlPaths(rendered.html),
            error: rendered?.html ? undefined : 'Block HTML is unavailable.'
        });
    }

    private async handlePdfRequest(id: string, path: string) {
        const pathText = decodeHtmlAttribute(path);
        if (!pathText.toLowerCase().endsWith('.pdf')) {
            this.postToPreview({ command: HostToPreviewCommand.PdfUri, id, error: 'Invalid PDF path' });
            return;
        }

        const uri = this.resolveProjectResourceUri(pathText);
        const url = await this.fileProvider.getResourceUrl(uri);
        if (!url) {
            this.addDiagnostic(`Missing PDF: ${pathText}`);
        }
        this.postToPreview(url
            ? { command: HostToPreviewCommand.PdfUri, id, path: pathText, uri: url }
            : { command: HostToPreviewCommand.PdfUri, id, path: pathText, error: 'PDF not found' });
    }

    private async fixHtmlPaths(html: string): Promise<string> {
        return replaceLocalResourceUrls(html, async (path, attribute) => {
            const url = await this.fileProvider.getResourceUrl(this.resolveProjectResourceUri(path));
            if (!url) {
                this.addDiagnostic(`${attribute === 'data-pdf-src' ? 'Missing PDF' : 'Missing image'}: ${path}`);
            }
            return url;
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
                virtualMode: this.settings.virtualMode,
                previewLayout: this.settings.previewLayout,
                style: {
                    fontSize: this.settings.fontSize,
                    lineHeight: this.settings.lineHeight,
                    contentMaxWidth: this.settings.contentMaxWidth,
                    fontFamily: this.settings.fontFamily
                }
            }
        });
    }

    private replaceDiagnostics(messages: readonly string[]) {
        const previous = [...this.diagnostics].join('\n');
        this.diagnostics.clear();
        messages.forEach(message => this.diagnostics.add(message));
        if (previous !== [...this.diagnostics].join('\n')) {
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
        const selection = pendingSelection;
        pendingSelection = undefined;
        if (selection && !host?.shouldSuppressEditorToPreview()) {
            host?.syncEditorSelection(
                selection.line,
                selection.character,
                selection.text,
                activeCursorScreenRatio,
                selection.auto
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
                flashEditorLineField,
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
    }, options.settings, () => {
        pendingSelection = undefined;
    });
    host.start();
    return host;
}
