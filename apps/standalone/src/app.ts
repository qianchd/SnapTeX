import { basicSetup, EditorView } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { BrowserFileProvider, BrowserUri, type BrowserProjectFile } from './browser-file-provider';
import { PreviewUpdateService } from '../../../src/preview-update-service';
import { SmartRenderer } from '../../../src/renderer';
import { decodeHtmlAttribute, escapeHtmlAttribute } from '../../../src/utils';
import { ExtensionToWebviewCommand, WebviewToExtensionCommand, type ExtensionToWebviewMessage, type WebviewToExtensionMessage } from '../../../src/webview-messages';

declare global {
    interface Window {
        snaptexStandaloneHost?: StandaloneHost;
        snaptexPreviewMessageQueue?: WebviewToExtensionMessage[];
    }
}

export interface StandaloneAppOptions {
    editorParent: HTMLElement;
    initialText: string;
    rootPath?: string;
    onStateChange?: (host: StandaloneHost) => void;
}

export interface StandaloneSaveResult {
    path: string;
    text: string;
    wroteToSource: boolean;
}

function debounce(callback: () => void, delayMs: number): () => void {
    let timer: number | undefined;
    return () => {
        if (timer !== undefined) {
            window.clearTimeout(timer);
        }
        timer = window.setTimeout(callback, delayMs);
    };
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
    private previewReady = false;
    private suppressNextEditorUpdate = false;

    constructor(
        private readonly editorView: EditorView,
        rootPath: string = '/main.tex',
        private readonly scheduleRender: () => void = () => undefined,
        private readonly onStateChange: () => void = () => undefined
    ) {
        this.rootUri = new BrowserUri(rootPath);
        this.activeUri = this.rootUri;
    }

    start() {
        window.snaptexStandaloneHost = this;
        const queued = window.snaptexPreviewMessageQueue ?? [];
        window.snaptexPreviewMessageQueue = [];
        queued.forEach(message => this.handlePreviewMessage(message));
    }

    async loadProject(files: readonly BrowserProjectFile[], rootPath: string) {
        this.fileProvider.setProjectFiles(files);
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

    private replaceEditorText(text: string) {
        if (this.editorView.state.doc.toString() !== text) {
            this.suppressNextEditorUpdate = true;
            this.editorView.dispatch({
                changes: { from: 0, to: this.editorView.state.doc.length, insert: text }
            });
        }
    }

    private persistActiveEditorText() {
        const text = this.editorView.state.doc.toString();
        this.fileProvider.setFile(this.activeUri, text);
        this.updateDirtyState(this.activeUri.path, text);
    }

    private markSaved(path: string, text: string) {
        this.savedTexts.set(path, text);
        this.updateDirtyState(path, text);
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
        const text = this.editorView.state.doc.toString();
        const wroteToSource = await this.fileProvider.write(this.activeUri, text);
        this.markSaved(this.activeUri.path, text);
        return {
            path: this.activeUri.path,
            text,
            wroteToSource
        };
    }

    handleEditorUpdate() {
        if (this.suppressNextEditorUpdate) {
            this.suppressNextEditorUpdate = false;
            return;
        }
        this.persistActiveEditorText();
        this.scheduleRender();
    }

    handlePreviewMessage(message: WebviewToExtensionMessage) {
        switch (message.command) {
            case WebviewToExtensionCommand.WebviewLoaded:
                this.previewReady = true;
                this.postToPreview({
                    command: ExtensionToWebviewCommand.Config,
                    config: {
                        autoScrollDelay: 100,
                        debugMemory: false,
                        virtualMode: true
                    }
                });
                void this.renderCurrentText();
                break;
            case WebviewToExtensionCommand.RequestBlockHtml:
                this.handleBlockHtmlRequest(message.id, message.index, message.hash);
                break;
            case WebviewToExtensionCommand.RequestPdf:
                this.handlePdfRequest(message.id, message.path);
                break;
            case WebviewToExtensionCommand.RevealLine:
            case WebviewToExtensionCommand.SyncScroll:
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
            deferFullHtml: true,
            transformHtml: html => this.fixHtmlPaths(html)
        });

        this.replaceDiagnostics(this.updateService.getDiagnostics().map(diagnostic => diagnostic.message));
        this.postToPreview({ command: ExtensionToWebviewCommand.Update, payload });
    }

    private handleBlockHtmlRequest(id: string, index: number, hash: string) {
        const rendered = this.updateService.renderBlockByIndex(index);
        this.postToPreview({
            command: ExtensionToWebviewCommand.BlockHtml,
            id,
            index,
            hash: rendered?.hash ?? hash,
            html: rendered?.html === undefined ? undefined : this.fixHtmlPaths(rendered.html),
            error: rendered?.html ? undefined : 'Block HTML is unavailable.'
        });
    }

    private handlePdfRequest(id: string, path: unknown) {
        const pathText = typeof path === 'string' ? decodeHtmlAttribute(path) : '';
        if (!pathText.toLowerCase().endsWith('.pdf')) {
            this.postToPreview({ command: ExtensionToWebviewCommand.PdfUri, id, error: 'Invalid PDF path' });
            return;
        }

        const uri = this.resolveProjectResourceUri(pathText);
        const url = this.fileProvider.getResourceUrl(uri);
        if (!url) {
            this.addDiagnostic(`Missing PDF: ${pathText}`);
        }
        this.postToPreview(url
            ? { command: ExtensionToWebviewCommand.PdfUri, id, path: pathText, uri: url }
            : { command: ExtensionToWebviewCommand.PdfUri, id, path: pathText, error: 'PDF not found' });
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

    private postToPreview(message: ExtensionToWebviewMessage) {
        window.postMessage(message, window.location.origin);
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
    }, 150);

    const editorView = new EditorView({
        parent: options.editorParent,
        state: EditorState.create({
            doc: options.initialText,
            extensions: [
                basicSetup,
                keymap.of([indentWithTab]),
                EditorView.lineWrapping,
                EditorView.updateListener.of(update => {
                    if (update.docChanged) {
                        host?.handleEditorUpdate();
                    }
                })
            ]
        })
    });

    host = new StandaloneHost(editorView, options.rootPath, scheduleRender, () => {
        if (host) {
            options.onStateChange?.(host);
        }
    });
    host.start();
    return host;
}
