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
    private previewReady = false;
    private suppressNextEditorUpdate = false;

    constructor(private readonly editorView: EditorView, rootPath: string = '/main.tex', private readonly scheduleRender: () => void = () => undefined) {
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
        this.rootUri = new BrowserUri(rootPath);
        this.activeUri = this.rootUri;
        const text = await this.fileProvider.read(this.activeUri);
        this.replaceEditorText(text);
        this.updateService.resetState();
        await this.renderCurrentText();
    }

    async openEditorFile(path: string) {
        this.persistActiveEditorText();
        this.activeUri = new BrowserUri(path);
        this.replaceEditorText(await this.fileProvider.read(this.activeUri));
        await this.renderCurrentText();
    }

    getRootPath(): string {
        return this.rootUri.path;
    }

    getActivePath(): string {
        return this.activeUri.path;
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
        this.fileProvider.setFile(this.activeUri, this.editorView.state.doc.toString());
    }

    async saveCurrentText(): Promise<StandaloneSaveResult> {
        const text = this.editorView.state.doc.toString();
        const wroteToSource = await this.fileProvider.write(this.activeUri, text);
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

        const text = this.editorView.state.doc.toString();
        this.fileProvider.setFile(this.activeUri, text);
        const rootText = await this.fileProvider.read(this.rootUri);
        const payload = await this.updateService.render(this.rootUri, rootText, {
            deferFullHtml: true,
            transformHtml: html => this.fixHtmlPaths(html)
        });

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
        this.postToPreview(url
            ? { command: ExtensionToWebviewCommand.PdfUri, id, path: pathText, uri: url }
            : { command: ExtensionToWebviewCommand.PdfUri, id, path: pathText, error: 'PDF not found' });
    }

    private fixHtmlPaths(html: string): string {
        return html.replace(/(src|data-pdf-src)="LOCAL_IMG:([^"]+)"/g, (_match, attr, relPath) => {
            const url = this.fileProvider.getResourceUrl(this.resolveProjectResourceUri(decodeHtmlAttribute(relPath)));
            return url ? `${attr}="${escapeHtmlAttribute(url)}"` : `${attr}=""`;
        });
    }

    private resolveProjectResourceUri(relativePath: string): BrowserUri {
        return this.fileProvider.resolve(this.fileProvider.dir(this.rootUri), relativePath);
    }

    private postToPreview(message: ExtensionToWebviewMessage) {
        window.postMessage(message, window.location.origin);
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

    host = new StandaloneHost(editorView, options.rootPath, scheduleRender);
    host.start();
    return host;
}
