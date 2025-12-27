import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
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

    // Event to notify when webview DOM is ready
    private readonly _onWebviewLoadedEmitter = new vscode.EventEmitter<void>();
    public readonly onWebviewLoaded = this._onWebviewLoadedEmitter.event;

    public get panel() {
        return this._panel;
    }

    public get sourceUri() {
        return this._sourceUri;
    }

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

        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: localResourceRoots
        };

        TexPreviewPanel.currentPanel = new TexPreviewPanel(panel, extensionPath, renderer);
    }

    private constructor(panel: vscode.WebviewPanel, extensionPath: string, renderer: SmartRenderer) {
        this._panel = panel;
        this._extensionPath = extensionPath;
        this._renderer = renderer;

        // Initialize File Provider and Document
        this._fileProvider = new NodeFileProvider();
        this._currentDocument = new LatexDocument(this._fileProvider);

        // Reset renderer state on new panel creation
        this._renderer.resetState();

        // Load the HTML content (skeleton)
        this._panel.webview.html = this._getWebviewSkeleton();

        // Handle messages from the Webview
        this._panel.webview.onDidReceiveMessage(
            message => {
                if (message.command === 'webviewLoaded') {
                    console.log('[SnapTeX] Webview reloaded (DOM reset detected). Forcing full re-render.');
                    this._renderer.resetState();
                    this.update();
                    this._onWebviewLoadedEmitter.fire();
                } else if (message.command === 'revealLine') {
                    this.handleRevealLine(message);
                } else if (message.command === 'syncScroll') {
                    vscode.commands.executeCommand(
                        'snaptex.internal.syncScroll',
                        message.index,
                        message.ratio
                    );
                }
            },
            null,
            this._disposables
        );

        // Initial update
        this.update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    private handleRevealLine(message: any) {
        if (this._sourceUri) {
             // 1. Get flattened line from block index
             const flatLine = this._renderer.getLineByBlockIndex(message.index, message.ratio);
             // 2. Map flattened line to original source location using the proxy
             const sourceLoc = this._renderer.getOriginalPosition(flatLine);

             if (sourceLoc) {
                 vscode.commands.executeCommand('snaptex.internal.revealLine', vscode.Uri.file(sourceLoc.file), sourceLoc.line, 0, message.anchor);
             }
        }
    }

    public postMessage(message: any) {
        this._panel.webview.postMessage(message);
    }

    public update() {
        const editor = vscode.window.activeTextEditor;
        let doc = editor ? editor.document : undefined;

        // If no active editor, try to find the document matching our source URI
        if (!doc && this._sourceUri) {
            doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === this._sourceUri!.toString());
        }

        if (!doc) {
            return;
        }

        const filename = path.basename(doc.fileName);
        this._panel.title = `𖧼 ${filename}`;

        this._sourceUri = doc.uri;
        const docDir = path.dirname(this._sourceUri.fsPath);
        const text = doc.getText();

        // Update Document Model
        if (this._currentDocument) {
            this._currentDocument.reparse(this._sourceUri.fsPath, text);

            // [FIXED] Pass the document to the renderer (1 argument)
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
        const katexPath = vscode.Uri.file(path.join(this._extensionPath, 'media', 'vendor', 'katex', 'katex.min.css'));
        const katexCssUri = this._panel.webview.asWebviewUri(katexPath);

        const stylePath = vscode.Uri.file(path.join(this._extensionPath, 'media', 'preview-style.css'));
        const styleUri = this._panel.webview.asWebviewUri(stylePath);

        const pdfJsPath = vscode.Uri.file(path.join(this._extensionPath, 'media', 'vendor', 'pdfjs', 'pdf.mjs'));
        const pdfJsUri = this._panel.webview.asWebviewUri(pdfJsPath);

        const pdfWorkerPath = vscode.Uri.file(path.join(this._extensionPath, 'media', 'vendor', 'pdfjs', 'pdf.worker.mjs'));
        const pdfWorkerUri = this._panel.webview.asWebviewUri(pdfWorkerPath);

        const htmlPath = path.join(this._extensionPath, 'src', 'webview.html');
        let htmlContent = '';
        try {
            htmlContent = fs.readFileSync(htmlPath, 'utf-8');
        } catch (e) {
            console.error('[SnapTeX] Failed to read webview.html:', e);
            return `<html><body>Error loading Webview HTML</body></html>`;
        }

        htmlContent = htmlContent
            .replace(/{{cspSource}}/g, this._panel.webview.cspSource)
            .replace(/{{katexCssUri}}/g, katexCssUri.toString())
            .replace(/{{styleUri}}/g, styleUri.toString())
            .replace(/{{pdfJsUri}}/g, pdfJsUri.toString())
            .replace(/{{pdfWorkerUri}}/g, pdfWorkerUri.toString());

        return htmlContent;
    }

    public dispose() {
        TexPreviewPanel.currentPanel = undefined;
        this._onWebviewLoadedEmitter.dispose();
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }
}