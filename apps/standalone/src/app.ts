import { basicSetup, EditorView } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { BrowserFileProvider, BrowserUri } from './browser-file-provider';
import { PreviewUpdateService } from '../../../src/preview-update-service';
import { SmartRenderer } from '../../../src/renderer';
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
    private readonly rootUri: BrowserUri;
    private readonly fileProvider = new BrowserFileProvider();
    private readonly updateService = new PreviewUpdateService(this.fileProvider, new SmartRenderer());
    private previewReady = false;

    constructor(private readonly editorView: EditorView, rootPath: string = '/main.tex') {
        this.rootUri = new BrowserUri(rootPath);
    }

    start() {
        window.snaptexStandaloneHost = this;
        const queued = window.snaptexPreviewMessageQueue ?? [];
        window.snaptexPreviewMessageQueue = [];
        queued.forEach(message => this.handlePreviewMessage(message));
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
                this.postToPreview({
                    command: ExtensionToWebviewCommand.PdfUri,
                    id: message.id,
                    path: message.path,
                    error: 'PDF rendering is not available in the first standalone web prototype.'
                });
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
        this.fileProvider.setFile(this.rootUri, text);
        const payload = await this.updateService.render(this.rootUri, text, {
            deferFullHtml: true
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
            html: rendered?.html,
            error: rendered?.html ? undefined : 'Block HTML is unavailable.'
        });
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
                        scheduleRender();
                    }
                })
            ]
        })
    });

    host = new StandaloneHost(editorView, options.rootPath);
    host.start();
    return host;
}
