import * as vscode from 'vscode';
import { SmartRenderer } from './renderer';
import { LatexDocument } from './document';
import { VscodeFileProvider } from './file-provider';
import { getBasename } from './utils';

// Helper: Convert Uint8Array to Base64
function uint8ToBase64(u8: Uint8Array): string {
    let binary = '';
    const len = u8.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(u8[i]);
    }
    if (typeof btoa === 'function') {
        return btoa(binary);
    } else if (typeof Buffer !== 'undefined') {
        return Buffer.from(u8).toString('base64');
    }
    return '';
}

export class TexPreviewPanel {
    public static currentPanel: TexPreviewPanel | undefined;
    public static readonly viewType = 'texPreview';
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _renderer: SmartRenderer;
    private _fileProvider: VscodeFileProvider;

    private _sourceUri: vscode.Uri | undefined;
    private _currentDocument: LatexDocument | undefined;
    private _updateVersion = 0;

    private readonly _onWebviewLoadedEmitter = new vscode.EventEmitter<void>();
    public readonly onWebviewLoaded = this._onWebviewLoadedEmitter.event;

    // [CHANGE] Constructor accepts Uri instead of string path
    public static createOrShow(extensionUri: vscode.Uri, renderer: SmartRenderer): TexPreviewPanel {
        const editor = vscode.window.activeTextEditor;
        const column = editor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
        if (TexPreviewPanel.currentPanel) {
            TexPreviewPanel.currentPanel._panel.reveal(column);
            return TexPreviewPanel.currentPanel;
        }

        // [CHANGE] Use vscode.Uri.joinPath for resource roots
        const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');

        const panel = vscode.window.createWebviewPanel(
            TexPreviewPanel.viewType,
            'Snap View',
            column,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri, mediaRoot],
                retainContextWhenHidden: true
            }
        );

        TexPreviewPanel.currentPanel = new TexPreviewPanel(panel, extensionUri, renderer);
        return TexPreviewPanel.currentPanel;
    }

    public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, renderer: SmartRenderer) {
        if (TexPreviewPanel.currentPanel) {
            TexPreviewPanel.currentPanel.dispose();
        }
        const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [extensionUri, mediaRoot]
        };

        TexPreviewPanel.currentPanel = new TexPreviewPanel(panel, extensionUri, renderer);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, renderer: SmartRenderer) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._renderer = renderer;

        this._fileProvider = new VscodeFileProvider();
        this._currentDocument = new LatexDocument(this._fileProvider);

        this._renderer.resetState();
        this._initWebviewHtml();

        this._panel.webview.onDidReceiveMessage(
            message => {
                if (message.command === 'webviewLoaded') {
                    console.log('[SnapTeX] Webview reloaded.');
                    this._renderer.resetState();
                    this.update();
                    this._onWebviewLoadedEmitter.fire();
                } else if (message.command === 'revealLine') {
                    this.handleRevealLine(message);
                } else if (message.command === 'syncScroll') {
                    vscode.commands.executeCommand('snaptex.internal.syncScroll', message.index, message.ratio);
                }
            },
            null,
            this._disposables
        );

        this.update();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    private async _initWebviewHtml() {
        this._panel.webview.html = await this._getWebviewSkeleton();
    }

    /**
     * [FIXED] Handles the double-click event from Webview.
     * Directly forwards the block index and ratio to the extension command.
     * Does NOT attempt to calculate the line number here.
     */
    private handleRevealLine(message: any) {
        if (this._sourceUri) {
            // Simply pass the URI (as context) and the raw message data
            // The extension command 'snaptex.internal.revealLine' expects (uri, index, ratio, anchor)
            vscode.commands.executeCommand(
                'snaptex.internal.revealLine',
                this._sourceUri,
                message.index,
                message.ratio,
                message.anchor,
                message.viewRatio
            );
        }
    }

    private async handlePdfRequest(message: any) {
        if (!this._sourceUri || !message.path) return;

        try {
            const docDir = vscode.Uri.joinPath(this._sourceUri, '..');
            // Normalize path separators
            const relPath = message.path.replace(/\\/g, '/');
            const pdfUri = vscode.Uri.joinPath(docDir, relPath);

            // Check existence first
            if (await this._fileProvider.exists(pdfUri)) {
                const fileData = await this._fileProvider.readBuffer(pdfUri);
                const base64 = uint8ToBase64(fileData);

                this.postMessage({
                    command: 'pdfData',
                    id: message.id,
                    data: base64
                });
            } else {
                console.warn(`[SnapTeX] PDF not found: ${pdfUri.toString()}`);
            }
        } catch (e) {
            console.error('[SnapTeX] Failed to read PDF:', e);
        }
    }

    public postMessage(message: any) {
        this._panel.webview.postMessage(message);
    }

    public async update() {
        const editor = vscode.window.activeTextEditor;
        let doc = editor ? editor.document : undefined;

        if (!doc && this._sourceUri) {
            const docs = vscode.workspace.textDocuments;
            doc = docs.find(d => d.uri.toString() === this._sourceUri!.toString());
        }
        if (!doc) { return; }

        const currentVersion = ++this._updateVersion;
        const filename = getBasename(doc.uri);
        this._panel.title = `𖧼 ${filename}`;
        this._sourceUri = doc.uri;

        const docDir = vscode.Uri.joinPath(this._sourceUri, '..');
        const text = doc.getText();

        if (this._currentDocument) {
            const parseResult = await this._currentDocument.parse(this._sourceUri, text);

            if (currentVersion !== this._updateVersion) { return; }

            this._currentDocument.applyResult(parseResult);
            let payload = this._renderer.render(this._currentDocument);
            this._currentDocument.releaseTextContent();

            const fixPaths = (html: string) => {
                let fixed = html.replace(/(src|data-pdf-src)="LOCAL_IMG:([^"]+)"/g, (match, attr, relPath) => {
                    try {
                        let normalizedPath = relPath.replace(/\\/g, '/');
                        if (normalizedPath.startsWith('./')) {
                            normalizedPath = normalizedPath.substring(2);
                        }
                        const pathSegments = normalizedPath.split('/');
                        const fullUri = vscode.Uri.joinPath(docDir, ...pathSegments);
                        const webviewUri = this._panel.webview.asWebviewUri(fullUri);
                        return `${attr}="${webviewUri.toString()}"`;
                    } catch (e) {
                        console.error(`[SnapTeX] Failed to resolve image path: ${relPath}`, e);
                        return match;
                    }
                });
                return fixed;
            };

            if (payload.type === 'full' && payload.html) {
                payload.html = fixPaths(payload.html);
            } else if (payload.type === 'patch' && payload.htmls) {
                payload.htmls = payload.htmls.map(h => fixPaths(h));
            }

            this._panel.webview.postMessage({ command: 'update', payload });
        }
    }

    private async _getWebviewSkeleton(): Promise<string> {
        // [CHANGE] Use joinPath instead of path.join
        const toUri = (p: string) => this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, p));

        const katexCssUri = toUri('media/vendor/katex/katex.min.css');
        const styleUri = toUri('media/preview-style.css');
        const pdfJsUri = toUri('media/vendor/pdfjs/pdf.mjs');
        const pdfWorkerUri = toUri('media/vendor/pdfjs/pdf.worker.mjs');

        const htmlUri = vscode.Uri.joinPath(this._extensionUri, 'media', 'webview.html');
        let htmlContent = '';
        try {
            htmlContent = await this._fileProvider.read(htmlUri);
        } catch (e) {
            console.error('[SnapTeX] Failed to read webview.html:', e);
            return `<html><body>Error loading Webview HTML</body></html>`;
        }

        return htmlContent
            .replace(/{{cspSource}}/g, this._panel.webview.cspSource)
            .replace(/{{katexCssUri}}/g, katexCssUri.toString())
            .replace(/{{styleUri}}/g, styleUri.toString())
            .replace(/{{pdfJsUri}}/g, pdfJsUri.toString())
            .replace(/{{pdfWorkerUri}}/g, pdfWorkerUri.toString());
    }

    public dispose() {
        TexPreviewPanel.currentPanel = undefined;
        this._onWebviewLoadedEmitter.dispose();
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }
}