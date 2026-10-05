import { basicSetup, EditorView } from 'codemirror';
import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, type DecorationSet, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import type { diffPatch } from 'node-diff3' with { 'resolution-mode': 'import' };
import { BrowserFileProvider, BrowserUri } from './browser-file-provider';
import { createLatexEditorExtensions, type LatexCompletionData } from './editor-assistance';
import {
    chooseRootPath,
    isPdfFile,
    isTexFile,
    isProjectTextFile,
    normalizeBrowserPath,
    normalizeProjectText as normalizeEditorText,
    ProjectWriteConflictError,
    type BrowserProject,
    type BrowserProjectSnapshot,
    type BrowserProjectTextChange,
    type PdfCompiler
} from './browser-project';
import { PreviewUpdateService } from '../../../src/preview-update-service';
import { resolveProjectResourcePath } from '../../../src/file-provider';
import { DEFAULT_PREVIEW_LAYOUT, DEFAULT_PREVIEW_STYLE_SETTINGS, type BackendMode, type PreviewLayoutMode, type PreviewStyleSettings, type SourceSyncOptions } from '../../../src/types';
import { debounce, decodeHtmlAttribute, getSyncAnchorContext, replaceLocalResourceUrls } from '../../../src/utils';
import { HostToPreviewCommand, PreviewToHostCommand, type HostToPreviewMessage, type PreviewToHostMessage } from '../../../src/preview-messages';

declare global {
    interface Window {
        snaptexStandaloneHost?: StandaloneHost;
        snaptexPreviewMessageQueue?: PreviewToHostMessage[];
    }
}

type PreviewRevealOptions = SourceSyncOptions & { viewRatio?: number };
type PdfSyncHandler = (path: string, line: number, column: number, viewRatio: number, auto: boolean) => void;

interface StandaloneAppOptions {
    editorParent: HTMLElement;
    initialText: string;
    rootPath?: string;
    settings?: Partial<StandalonePreviewSettings>;
    onStateChange?: (host: StandaloneHost) => void;
    onResourceChange?: (path: string) => void;
}

interface StandaloneSaveResult {
    path: string;
    text: string;
    wroteToSource: boolean;
}

export interface StandalonePreviewSettings extends PreviewStyleSettings {
    livePreview: boolean;
    autoScrollSync: boolean;
    autoSave: boolean;
    autoSaveDelaySeconds: number;
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
    autoSave: true,
    autoSaveDelaySeconds: 1,
    renderDelayMs: 150,
    autoScrollDelayMs: 100,
    virtualMode: true,
    backendMode: 'legacy',
    previewLayout: DEFAULT_PREVIEW_LAYOUT,
    debugMemory: false
};

function normalizeAutoSaveDelay(seconds: number): number {
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) : DEFAULT_STANDALONE_PREVIEW_SETTINGS.autoSaveDelaySeconds;
}

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
    private readonly conflictedPaths = new Set<string>();
    private projectOperations: BrowserProject['operations'];
    private setProjectActivePath: BrowserProject['setActivePath'];
    private setProjectRootPath: BrowserProject['setRootPath'];
    private projectName = 'SnapTeX Project';
    private autosaveTimer: number | undefined;
    private projectQueue: Promise<void> = Promise.resolve();
    private stopProjectWatch: (() => void) | undefined;
    private labels: string[] = [];
    private previewReady = false;
    private pdfSyncHandler?: PdfSyncHandler;
    private editorVisible = true;
    private previewVisible = true;
    private pendingEditorScroll: { position: number; viewRatio: number } | undefined;
    private pendingPreviewSync: { line: number; character: number; lineText?: string; viewRatio: number; auto: boolean } | undefined;
    private previewControlsSync = false;
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
        private readonly cancelPendingEditorSync: () => void = () => undefined,
        private readonly onResourceChange: (path: string) => void = () => undefined
    ) {
        this.rootUri = new BrowserUri(rootPath);
        this.activeUri = this.rootUri;
        this.settings = { ...DEFAULT_STANDALONE_PREVIEW_SETTINGS, ...settings };
        this.settings.autoSaveDelaySeconds = normalizeAutoSaveDelay(this.settings.autoSaveDelaySeconds);
    }

    start() {
        window.snaptexStandaloneHost = this;
        const queued = window.snaptexPreviewMessageQueue ?? [];
        window.snaptexPreviewMessageQueue = [];
        queued.forEach(message => void this.handlePreviewMessage(message));
    }

    async loadProject(project: BrowserProject): Promise<string> {
        await this.flushProjectWrites();
        this.stopProjectWatch?.();
        this.stopProjectWatch = undefined;
        const rootPath = project.rootPath ?? chooseRootPath(project.files);
        if (!rootPath) {
            throw new Error('No TeX root file found.');
        }
        this.fileProvider.setProjectFiles(project.files);
        this.projectOperations = project.operations;
        this.setProjectActivePath = project.setActivePath;
        this.setProjectRootPath = project.setRootPath;
        this.projectName = project.name ?? rootPath;
        this.labels = [];
        this.pendingEditorScroll = undefined;
        this.pendingPreviewSync = undefined;
        this.previewControlsSync = false;
        this.savedTexts.clear();
        this.dirtyPaths.clear();
        this.conflictedPaths.clear();
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
        this.onStateChange();
        await this.renderCurrentText();
        this.stopProjectWatch = project.watchFiles?.(
            change => this.queueProjectChange(change),
            error => this.addDiagnostic(`Project sync failed: ${error instanceof Error ? error.message : String(error)}`),
            file => {
                this.fileProvider.setProjectFile(file);
                this.onResourceChange(file.path);
            }
        );
        return rootPath;
    }

    async openEditorFile(path: string, isCurrent: () => boolean = () => true) {
        await this.flushProjectWrites();
        if (!isCurrent()) {return;}
        this.persistActiveEditorText();
        const targetUri = new BrowserUri(path);
        const text = await this.fileProvider.read(targetUri);
        if (!isCurrent()) {return;}
        await this.setProjectActivePath?.(targetUri.path);
        if (!isCurrent()) {return;}
        this.activeUri = targetUri;
        if (!this.savedTexts.has(targetUri.path)) {
            this.markSaved(targetUri.path, text);
        }
        this.replaceEditorText(text);
        this.onStateChange();
    }

    async setPreviewRoot(path: string) {
        await this.flushProjectWrites();
        this.persistActiveEditorText();
        const rootUri = new BrowserUri(path);
        if (!isTexFile(rootUri.path) || !this.fileProvider.has(rootUri.path)) {
            throw new Error(`Project TeX file does not exist: ${rootUri.path}`);
        }
        await this.setProjectRootPath?.(rootUri.path);
        this.rootUri = rootUri;
        this.updateService.resetState();
        this.onStateChange();
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
        return [
            ...this.diagnostics,
            ...[...this.conflictedPaths].map(path => `Resolve remote edit conflict markers in ${path}.`)
        ];
    }

    getProjectTextPaths(): readonly string[] {
        return this.fileProvider.getPaths().filter(isProjectTextFile);
    }

    getProjectPdfPaths(): readonly string[] {
        return this.fileProvider.getPaths().filter(isPdfFile);
    }

    readProjectPdf(path: string): Promise<Blob> {
        if (!isPdfFile(path)) {
            throw new Error('Only PDF files can open in the PDF preview.');
        }
        return this.fileProvider.readBlob(new BrowserUri(path));
    }

    setPdfPreview(sync?: PdfSyncHandler): void {
        const changed = !!this.pdfSyncHandler !== !!sync;
        this.pdfSyncHandler = sync;
        if (!changed) {return;}
        this.pendingPreviewSync = undefined;
        this.cancelPendingEditorSync();
        this.updateService.resetState();
        if (!sync) {void this.renderCurrentText();}
    }

    async readPdfSyncData(pdfPath: string): Promise<{ blob: Blob; compressed: boolean } | undefined> {
        for (const extension of ['.synctex.gz', '.synctex']) {
            const path = pdfPath.replace(/\.pdf$/i, extension);
            if (this.fileProvider.has(path)) {
                return { blob: await this.fileProvider.readBlob(new BrowserUri(path)), compressed: extension.endsWith('.gz') };
            }
        }
        return undefined;
    }

    async revealEditorLocation(path: string, line: number, column: number, viewRatio = 0.5, auto = false,
        isCurrent: () => boolean = () => true): Promise<void> {
        if (!isCurrent()) {return;}
        if (auto && (!this.settings.autoScrollSync || !this.previewControlsSync)) {return;}
        const targetPath = normalizeBrowserPath(path);
        if (targetPath !== this.activeUri.path) {
            await this.openEditorFile(targetPath, isCurrent);
        }
        if (!isCurrent()) {return;}
        if (auto && (!this.pdfSyncHandler || !this.previewControlsSync)) {return;}
        const doc = this.editorView.state.doc;
        const targetLine = doc.line(Math.max(1, Math.min(doc.lines, line)));
        const position = Math.min(targetLine.to, targetLine.from + Math.max(0, column - 1));
        this.suppressEditorToPreview();
        if (auto) {this.syncEditorPosition(position, viewRatio); return;}
        this.suppressNextSelectionSync = true;
        this.editorView.dispatch({ selection: { anchor: position }, effects: flashEditorLineEffect.of(position) });
        this.syncEditorPosition(position, viewRatio);
        const token = ++this.editorFlashToken;
        globalThis.setTimeout(() => {
            if (token === this.editorFlashToken) {this.editorView.dispatch({ effects: flashEditorLineEffect.of(null) });}
        }, 1200);
    }

    canCompilePdf(): boolean {
        return this.projectOperations?.compilePdf !== undefined;
    }

    async compilePdf(compiler: PdfCompiler): Promise<string> {
        const compile = this.projectOperations?.compilePdf;
        if (!compile) {
            throw new Error('PDF compilation is available only for server projects.');
        }
        await this.flushProjectWrites();
        this.persistActiveEditorText();
        if (this.isDirty(this.activeUri.path)) {
            await this.saveCurrentText();
        }
        if (this.dirtyPaths.size > 0) {
            throw new Error(`Save the other modified files before compiling: ${[...this.dirtyPaths].join(', ')}`);
        }
        const files = await compile(this.rootUri.path, compiler);
        if (compile !== this.projectOperations?.compilePdf) {
            throw new Error('The project changed while PDF compilation was running.');
        }
        for (const file of files) {this.fileProvider.setProjectFile(file);}
        this.onStateChange();
        const pdf = files.find(file => isPdfFile(file.path));
        if (!pdf) {throw new Error('Compilation finished without a PDF.');}
        return pdf.path;
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
        await this.renderCurrentText();
    }

    async deleteTextFile(path: string): Promise<void> {
        await this.flushProjectWrites();
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
        this.conflictedPaths.delete(normalizedPath);
        this.updateService.resetState();
        if (this.activeUri.path === normalizedPath) {
            this.activeUri = this.rootUri;
            await this.setProjectActivePath?.(this.rootUri.path);
            const text = await this.fileProvider.read(this.rootUri);
            if (!this.savedTexts.has(this.rootUri.path)) {this.markSaved(this.rootUri.path, text);}
            this.replaceEditorText(text);
        }
        this.onStateChange();
        await this.renderCurrentText();
    }

    getSettings(): StandalonePreviewSettings {
        return { ...this.settings };
    }

    async updateSettings(settings: Partial<StandalonePreviewSettings>): Promise<void> {
        const previousVirtualMode = this.settings.virtualMode;
        const previousLivePreview = this.settings.livePreview;
        const previousBackendMode = this.settings.backendMode;
        const previousAutoSave = this.settings.autoSave;
        const previousSaveDelay = this.settings.autoSaveDelaySeconds;
        this.settings = { ...this.settings, ...settings };
        this.settings.autoSaveDelaySeconds = normalizeAutoSaveDelay(this.settings.autoSaveDelaySeconds);
        if (previousAutoSave !== this.settings.autoSave || previousSaveDelay !== this.settings.autoSaveDelaySeconds) {
            this.scheduleAutosave();
        }
        const virtualModeChanged = previousVirtualMode !== this.settings.virtualMode;
        const backendModeChanged = previousBackendMode !== this.settings.backendMode;
        const shouldRender = virtualModeChanged || backendModeChanged || (!previousLivePreview && this.settings.livePreview);
        if (this.previewReady) {
            this.postPreviewConfig();
            if (virtualModeChanged || backendModeChanged) {
                this.updateService.resetState();
            }
        }
        this.onStateChange();
        if (this.previewReady && shouldRender) {
            await this.renderCurrentText();
        }
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

    private updateEditorText(text: string, buildPatch: typeof diffPatch) {
        const document = this.editorView.state.doc;
        const current = document.toString();
        const changes = buildPatch(current.match(/[^\n]*\n|[^\n]+/g) ?? [], text.match(/[^\n]*\n|[^\n]+/g) ?? [])
            .map(({ buffer1, buffer2 }) => {
                let from = buffer1.offset < document.lines ? document.line(buffer1.offset + 1).from : current.length;
                const endLine = buffer1.offset + buffer1.length;
                let to = endLine < document.lines ? document.line(endLine + 1).from : current.length;
                let insert = buffer2.chunk.join('');
                let start = 0;
                while (from < to && start < insert.length && current[from] === insert[start]) {from++; start++;}
                let end = insert.length;
                while (to > from && end > start && current[to - 1] === insert[end - 1]) {to--; end--;}
                insert = insert.slice(start, end);
                return { from, to, insert };
            });
        if (!changes.length) {return;}

        this.programmaticEditorUpdate = true;
        try {
            this.editorView.dispatch({
                changes,
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

    private async writeCurrentText(retryAfterMerge = true): Promise<StandaloneSaveResult> {
        const text = this.editorView.state.doc.toString();
        const path = this.activeUri.path;
        if (this.conflictedPaths.has(path) && text.includes('<<<<<<< LOCAL')) {
            throw new Error(`Resolve the remote edit conflict markers in ${path} before saving.`);
        }
        let wroteToSource: boolean;
        try {
            wroteToSource = await this.fileProvider.write(this.activeUri, text, this.savedTexts.get(path));
        } catch (error) {
            if (!(error instanceof ProjectWriteConflictError)) {
                throw error;
            }
            const conflict = await this.applyProjectTextChange({ path, text: error.remoteText });
            if (!conflict && retryAfterMerge) {
                return this.writeCurrentText(false);
            }
            throw new Error(`Remote edits conflict with local changes in ${path}; resolve the inserted markers before saving.`);
        }
        this.markSaved(path, text, this.editorView.state.doc.toString());
        this.conflictedPaths.delete(path);
        return { path, text, wroteToSource };
    }

    private queueProjectTask<T>(task: () => Promise<T>): Promise<T> {
        const result = this.projectQueue.then(task);
        this.projectQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    private queueProjectChange(change: BrowserProjectTextChange): Promise<void> {
        const path = normalizeBrowserPath(change.path);
        const baseText = this.savedTexts.get(path);
        return this.queueProjectTask(async () => {
            if (!this.fileProvider.has(path)) {return;}
            const text = this.savedTexts.get(path) === baseText
                ? change.text
                : await this.fileProvider.readSourceText(new BrowserUri(path));
            await this.applyProjectTextChange({ path, text });
        });
    }

    private async applyProjectTextChange(change: BrowserProjectTextChange): Promise<boolean> {
        const path = normalizeBrowserPath(change.path);
        if (!this.fileProvider.has(path)) {
            return false;
        }

        const remoteText = normalizeEditorText(change.text);
        const baseText = this.savedTexts.get(path);
        const uri = new BrowserUri(path);
        if (baseText === undefined && path !== this.activeUri.path) {
            this.savedTexts.set(path, remoteText);
            this.fileProvider.setFile(uri, remoteText);
            await this.renderCurrentText();
            return false;
        }
        if (remoteText === baseText) {
            return false;
        }
        // Snapshot the editor after the async module load, then merge and apply without yielding.
        const { diffPatch, mergeDiff3 } = await import('node-diff3');
        const localText = path === this.activeUri.path
            ? this.editorView.state.doc.toString()
            : await this.fileProvider.read(uri);
        let merged = { text: remoteText, conflict: false };
        if (baseText !== undefined && localText !== baseText && localText !== remoteText) {
            const result = mergeDiff3(localText.split('\n'), baseText.split('\n'), remoteText.split('\n'), {
                excludeFalseConflicts: true,
                label: { a: 'LOCAL', o: 'BASE', b: 'REMOTE' }
            });
            merged = { text: result.result.join('\n'), conflict: result.conflict };
        }
        this.savedTexts.set(path, remoteText);
        this.fileProvider.setFile(uri, merged.text);
        this.updateDirtyState(path, merged.text);
        if (merged.conflict) {
            this.conflictedPaths.add(path);
        } else {
            this.conflictedPaths.delete(path);
        }
        if (path === this.activeUri.path) {
            this.updateEditorText(merged.text, diffPatch);
            if (!merged.conflict && this.isDirty(path)) {this.scheduleAutosave();}
        }
        this.onStateChange();
        await this.renderCurrentText();
        return merged.conflict;
    }

    private scheduleAutosave(): void {
        this.clearAutosaveTimer();
        if (!this.settings.autoSave || !this.isDirty(this.activeUri.path) || !this.fileProvider.isWritable(this.activeUri)) {
            return;
        }
        this.autosaveTimer = window.setTimeout(() => {
            this.autosaveTimer = undefined;
            void this.queueAutosave().catch(error => this.addDiagnostic(`Autosave failed: ${error instanceof Error ? error.message : String(error)}`));
        }, this.settings.autoSaveDelaySeconds * 1000);
    }

    private queueAutosave(): Promise<void> {
        return this.queueProjectTask(async () => {
            // An edit while this task waited in the queue starts a new quiet period.
            if (this.autosaveTimer === undefined && this.settings.autoSave && this.fileProvider.isWritable(this.activeUri) && this.isDirty(this.activeUri.path)) {
                await this.writeCurrentText();
            }
        });
    }

    private clearAutosaveTimer(): void {
        if (this.autosaveTimer !== undefined) {
            window.clearTimeout(this.autosaveTimer);
            this.autosaveTimer = undefined;
        }
    }

    private markSaved(path: string, text: string, currentText = text) {
        const normalizedText = normalizeEditorText(text);
        this.savedTexts.set(path, normalizedText);
        this.updateDirtyState(path, normalizeEditorText(currentText));
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
            this.onStateChange();
        }
    }

    async saveCurrentText(): Promise<StandaloneSaveResult> {
        this.clearAutosaveTimer();
        return this.queueProjectTask(() => this.writeCurrentText());
    }

    async flushProjectWrites(): Promise<void> {
        this.clearAutosaveTimer();
        await this.queueAutosave();
    }

    async createProjectSnapshot(): Promise<BrowserProjectSnapshot> {
        await this.flushProjectWrites();
        return {
            name: this.projectName,
            files: await this.fileProvider.snapshot()
        };
    }

    syncEditorSelection(line: number, character = 0, lineText?: string, viewRatio = 0.5, auto = true) {
        if (!auto) { this.beginEditorInteraction(); }
        if ((auto && (!this.settings.autoScrollSync || !this.editorVisible || this.previewControlsSync)) || (!this.previewReady && !this.pdfSyncHandler)) {
            return;
        }
        if (!this.previewVisible) {
            this.pendingPreviewSync = { line, character, lineText, viewRatio, auto };
            return;
        }
        if (Date.now() < this.suppressEditorToPreviewUntil) {
            return;
        }
        this.pendingPreviewSync = undefined;
        if (this.pdfSyncHandler) {
            this.pdfSyncHandler(this.activeUri.path, line + 1, character + 1, viewRatio, auto);
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

    setPaneVisibility(editorVisible: boolean, previewVisible: boolean): void {
        this.editorVisible = editorVisible;
        this.previewVisible = previewVisible;
        if (previewVisible && this.pendingPreviewSync) {
            const pending = this.pendingPreviewSync;
            this.pendingPreviewSync = undefined;
            this.syncEditorSelection(pending.line, pending.character, pending.lineText, pending.viewRatio, pending.auto);
        }
        if (editorVisible && this.pendingEditorScroll) {
            const { position, viewRatio } = this.pendingEditorScroll;
            this.pendingEditorScroll = undefined;
            this.scrollEditorPositionToViewRatio(position, viewRatio);
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

    private syncEditorPosition(position: number, viewRatio: number) {
        if (!this.editorVisible) {
            this.pendingEditorScroll = { position, viewRatio };
            return;
        }
        this.scrollEditorPositionToViewRatio(position, viewRatio);
    }

    consumeSelectionSyncSuppression(): boolean {
        const suppressed = this.suppressNextSelectionSync;
        this.suppressNextSelectionSync = false;
        return suppressed;
    }

    private cancelEditorToPreviewSync() {
        this.pendingPreviewSync = undefined;
        this.cancelPendingEditorSync();
    }

    beginPreviewScroll() {
        this.previewControlsSync = true;
        this.suppressPreviewToEditorUntil = 0;
        this.cancelEditorToPreviewSync();
    }

    beginEditorInteraction() {
        this.previewControlsSync = false;
        this.suppressEditorToPreviewUntil = 0;
    }

    canAutoSyncPdf(direction: 'forward' | 'inverse'): boolean {
        return !!this.pdfSyncHandler && this.settings.autoScrollSync && this.previewVisible &&
            (direction === 'forward' ? !this.previewControlsSync : this.previewControlsSync);
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

        return source;
    }

    async revealPreviewLocation(index: number, ratio: number, options: PreviewRevealOptions = {}) {
        this.cancelEditorToPreviewSync();
        const target = await this.openSourceForPreview(index, ratio, options);
        if (!target) {
            return;
        }
        await this.revealEditorLocation(target.file, target.line + 1, 1, options.viewRatio);
    }

    async syncPreviewScroll(index: number, ratio: number, options: SourceSyncOptions = {}) {
        if (this.pdfSyncHandler || !this.settings.autoScrollSync || Date.now() < this.suppressPreviewToEditorUntil) {
            return;
        }

        this.beginPreviewScroll();
        const target = await this.openSourceForPreview(index, ratio, options);
        if (!target || Date.now() < this.suppressPreviewToEditorUntil) {
            return;
        }

        const doc = this.editorView.state.doc;
        const position = doc.line(Math.max(1, Math.min(doc.lines, target.line + 1))).from;
        this.suppressEditorToPreview();
        this.syncEditorPosition(position, 0.5);
    }

    handleEditorUpdate() {
        if (this.programmaticEditorUpdate) { return; }
        this.beginEditorInteraction();
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
                await this.renderCurrentText();
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
                if (!this.pdfSyncHandler) {void this.revealPreviewLocation(message.index, message.ratio, message);}
                break;
            case PreviewToHostCommand.SyncScroll:
                void this.syncPreviewScroll(message.index, message.ratio, message);
                break;
            case PreviewToHostCommand.PreviewScrollStarted:
                this.beginPreviewScroll();
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
        if (!this.previewReady || this.pdfSyncHandler || this.fileProvider.isEmpty()) {
            return;
        }

        this.persistActiveEditorText();
        const rootText = await this.fileProvider.read(this.rootUri);
        const payload = await this.updateService.render(this.rootUri, rootText, {
            deferFullHtml: this.settings.virtualMode,
            backendMode: this.settings.backendMode,
            transformHtml: html => this.fixHtmlPaths(html)
        });
        if (this.pdfSyncHandler) {return;}

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
        if (!uri) {
            this.postToPreview({ command: HostToPreviewCommand.PdfUri, id, error: 'PDF path is outside the project root' });
            return;
        }
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
            const uri = this.resolveProjectResourceUri(path);
            const url = uri && await this.fileProvider.getResourceUrl(uri);
            if (!url) {
                this.addDiagnostic(`${attribute === 'data-pdf-src' ? 'Missing PDF' : 'Missing image'}: ${path}`);
            }
            return url;
        });
    }

    private resolveProjectResourceUri(relativePath: string): BrowserUri | undefined {
        const baseDirectory = this.fileProvider.dir(this.rootUri).path.replace(/^\/+/, '');
        const path = resolveProjectResourcePath(baseDirectory, relativePath);
        return path ? new BrowserUri(`/${path}`) : undefined;
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
                    fontFamily: this.settings.fontFamily,
                    pageMargin: this.settings.pageMargin,
                    continuousMargin: this.settings.continuousMargin
                }
            }
        });
    }

    private replaceDiagnostics(messages: readonly string[]) {
        const previous = [...this.diagnostics].join('\n');
        this.diagnostics.clear();
        messages.forEach(message => this.diagnostics.add(message));
        if (previous !== [...this.diagnostics].join('\n')) {
            this.onStateChange();
        }
    }

    private addDiagnostic(message: string) {
        const size = this.diagnostics.size;
        this.diagnostics.add(message);
        if (this.diagnostics.size !== size) {
            this.onStateChange();
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
        if (selection) {
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
        if (view.scrollDOM.clientHeight <= 0) { return; }
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
                        host?.beginEditorInteraction();
                        updateCursorScreenRatio(update.view);
                        scheduleEditorSelectionSync(update.view, true);
                    }
                }),
                EditorView.domEventHandlers({
                    pointerdown: () => { host?.beginEditorInteraction(); },
                    wheel: () => { host?.beginEditorInteraction(); },
                    keydown: () => { host?.beginEditorInteraction(); },
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
        scheduleSelectionSync.cancel();
    }, options.onResourceChange);
    host.start();
    return host;
}
