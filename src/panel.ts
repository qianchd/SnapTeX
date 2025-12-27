import * as vscode from 'vscode';
import * as path from 'path';
import { SmartRenderer } from './renderer';
import { LatexDocument } from './document';
import { NodeFileProvider } from './file-provider';

export class TexPreviewPanel {
    public static currentPanel: TexPreviewPanel | undefined;
    public static readonly viewType = 'texPreview';
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionPath: string;
    private _disposables: vscode.Disposable[] = [];
    private _renderer: SmartRenderer;
    private _fileProvider: NodeFileProvider;

    private _sourceUri: vscode.Uri | undefined;
    private _currentDocument: LatexDocument | undefined;

    private readonly _onWebviewLoadedEmitter = new vscode.EventEmitter<void>();
    public readonly onWebviewLoaded = this._onWebviewLoadedEmitter.event;

    public get panel() { return this._panel; }
    public get sourceUri() { return this._sourceUri; }

    public static createOrShow(extensionPath: string, renderer: SmartRenderer): TexPreviewPanel {
        const editor = vscode.window.activeTextEditor;
        const column = editor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;

        if (TexPreviewPanel.currentPanel) {
            TexPreviewPanel.currentPanel._panel.reveal(column);
            return TexPreviewPanel.currentPanel;
        }

        let title = 'Snap View';
        if (editor) {
            title = `𖧼 ${path.basename(editor.document.fileName)}`;
        }

        const localResourceRoots = [
            vscode.Uri.file(extensionPath),
            vscode.Uri.file(path.join(extensionPath, 'media'))
        ];

        if (vscode.workspace.workspaceFolders) {
            vscode.workspace.workspaceFolders.forEach(folder => {
                localResourceRoots.push(folder.uri);
            });
        }

        const panel = vscode.window.createWebviewPanel(
            TexPreviewPanel.viewType,
            title,
            column,
            {
                enableScripts: true,
                localResourceRoots: localResourceRoots,
                retainContextWhenHidden: true
            }
        );

        TexPreviewPanel.currentPanel = new TexPreviewPanel(panel, extensionPath, renderer);
        return TexPreviewPanel.currentPanel;
    }

    public static revive(panel: vscode.WebviewPanel, extensionPath: string, renderer: SmartRenderer) {
        if (TexPreviewPanel.currentPanel) {
            TexPreviewPanel.currentPanel.dispose();
        }
        const localResourceRoots = [
            vscode.Uri.file(extensionPath),
            vscode.Uri.file(path.join(extensionPath, 'media'))
        ];
        if (vscode.workspace.workspaceFolders) {
            vscode.workspace.workspaceFolders.forEach(folder => {
                localResourceRoots.push(folder.uri);
            });
        }
        panel.webview.options = { enableScripts: true, localResourceRoots: localResourceRoots };
        TexPreviewPanel.currentPanel = new TexPreviewPanel(panel, extensionPath, renderer);
    }

    private constructor(panel: vscode.WebviewPanel, extensionPath: string, renderer: SmartRenderer) {
        this._panel = panel;
        this._extensionPath = extensionPath;
        this._renderer = renderer;

        this._fileProvider = new NodeFileProvider();
        this._currentDocument = new LatexDocument(this._fileProvider);

        this._renderer.resetState();
        this._panel.webview.html = this._getWebviewSkeleton();

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

    public postMessage(message: any) {
        this._panel.webview.postMessage(message);
    }

    public update() {
        const editor = vscode.window.activeTextEditor;
        let doc = editor ? editor.document : undefined;

        if (!doc && this._sourceUri) {
            doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === this._sourceUri!.toString());
        }
        if (!doc) { return; }

        const filename = path.basename(doc.fileName);
        this._panel.title = `𖧼 ${filename}`;
        this._sourceUri = doc.uri;

        const docDir = path.dirname(this._sourceUri.fsPath);
        const text = doc.getText();

        if (this._currentDocument) {
            this._currentDocument.reparse(this._sourceUri.fsPath, text);

            // Pass document to renderer
            let payload = this._renderer.render(this._currentDocument);

            const fixPaths = (html: string) => {
                let fixed = html.replace(/src="LOCAL_IMG:([^"]+)"/g, (match, relPath) => {
                    const fullPath = path.isAbsolute(relPath) ? relPath : path.join(docDir, relPath);
                    const uri = this._panel.webview.asWebviewUri(vscode.Uri.file(fullPath));
                    return `src="${uri}"`;
                });
                fixed = fixed.replace(/data-pdf-src="LOCAL_IMG:([^"]+)"/g, (match, relPath) => {
                    const fullPath = path.isAbsolute(relPath) ? relPath : path.join(docDir, relPath);
                    const uri = this._panel.webview.asWebviewUri(vscode.Uri.file(fullPath));
                    return `data-pdf-src="${uri}"`;
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

    private _getWebviewSkeleton() {
        const toUri = (p: string) => this._panel.webview.asWebviewUri(vscode.Uri.file(path.join(this._extensionPath, p)));

        const katexCssUri = toUri('media/vendor/katex/katex.min.css');
        const styleUri = toUri('media/preview-style.css');
        const pdfJsUri = toUri('media/vendor/pdfjs/pdf.mjs');
        const pdfWorkerUri = toUri('media/vendor/pdfjs/pdf.worker.mjs');

        const htmlPath = path.join(this._extensionPath, 'media', 'webview.html');
        let htmlContent = '';
        try {
            // [Refactor] Use fileProvider to read the file instead of fs
            htmlContent = this._fileProvider.read(htmlPath);
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