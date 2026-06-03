import * as vscode from 'vscode';
import { SmartRenderer } from './renderer';
import { LatexDocument } from './document';
import { VscodeFileProvider } from './file-provider';
import { getBasename } from './utils';

// Helper: Convert Uint8Array to Base64
function uint8ToBase64(u8: Uint8Array): string {
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(u8).toString('base64');
    }

    const CHUNK_SIZE = 0x8000;
    const chunks: string[] = [];
    for (let i = 0; i < u8.length; i += CHUNK_SIZE) {
        const chunk = u8.subarray(i, i + CHUNK_SIZE);
        chunks.push(String.fromCharCode.apply(null, chunk as unknown as number[]));
    }
    return btoa(chunks.join(''));
}

function isDebugMemoryEnabled(): boolean {
    return vscode.workspace.getConfiguration('snaptex').get<boolean>('debugMemory', false);
}

function logHostMemory(label: string) {
    if (!isDebugMemoryEnabled()) {
        return;
    }

    if (typeof process === 'undefined' || typeof process.memoryUsage !== 'function') {
        console.log(`[SnapTeX][mem] ${label}`, { unavailable: true });
        return;
    }

    const memory = process.memoryUsage();
    const mb = (value: number) => `${Math.round(value / 1024 / 1024)}MB`;
    console.log(`[SnapTeX][mem] ${label}`, {
        rss: mb(memory.rss),
        heapUsed: mb(memory.heapUsed),
        heapTotal: mb(memory.heapTotal),
        external: mb(memory.external)
    });
}

export function normalizePdfRequestPath(input: unknown): string | undefined {
    if (typeof input !== 'string') {
        return undefined;
    }

    let cleanPath = input.trim().replace(/\\/g, '/');
    while (cleanPath.startsWith('./')) {
        cleanPath = cleanPath.substring(2);
    }

    if (
        !cleanPath ||
        cleanPath.includes('\0') ||
        !cleanPath.toLowerCase().endsWith('.pdf') ||
        cleanPath.startsWith('/') ||
        /^[a-zA-Z]:\//.test(cleanPath) ||
        cleanPath.split('/').includes('..')
    ) {
        return undefined;
    }

    return cleanPath;
}

export type PdfRequestMode = 'uri' | 'base64';

export function getPdfRequestMode(message: { transport?: unknown } | undefined): PdfRequestMode {
    return message?.transport === 'base64' ? 'base64' : 'uri';
}

function normalizeUriPathForContainment(uri: vscode.Uri): string {
    let path = uri.path.replace(/\/+/g, '/');
    if (path.length > 1) {
        path = path.replace(/\/+$/g, '');
    }

    const isWindowsFileUri = uri.scheme === 'file' && typeof process !== 'undefined' && process.platform === 'win32';
    return isWindowsFileUri ? path.toLowerCase() : path;
}

export function isUriWithinAllowedRoots(uri: vscode.Uri, roots: vscode.Uri[]): boolean {
    const childPath = normalizeUriPathForContainment(uri);

    return roots.some(root => {
        if (uri.scheme !== root.scheme || uri.authority !== root.authority) {
            return false;
        }

        const rootPath = normalizeUriPathForContainment(root);
        const rootPrefix = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
        return childPath === rootPath || childPath.startsWith(rootPrefix);
    });
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
    private _updateRunning = false;
    private _pendingRootUri: vscode.Uri | undefined;

    private readonly _onWebviewLoadedEmitter = new vscode.EventEmitter<void>();
    public readonly onWebviewLoaded = this._onWebviewLoadedEmitter.event;

    // Constructor accepts Uri instead of string path
    public static createOrShow(extensionUri: vscode.Uri, renderer: SmartRenderer): TexPreviewPanel {
        const editor = vscode.window.activeTextEditor;
        const column = editor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
        if (TexPreviewPanel.currentPanel) {
            TexPreviewPanel.currentPanel._panel.reveal(column);
            return TexPreviewPanel.currentPanel;
        }

        // Use vscode.Uri.joinPath for resource roots
        const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
        const retainContextWhenHidden = vscode.workspace
            .getConfiguration('snaptex')
            .get<boolean>('retainContextWhenHidden', false);

        const panel = vscode.window.createWebviewPanel(
            TexPreviewPanel.viewType,
            'Snap View',
            column,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri, mediaRoot],
                retainContextWhenHidden
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
            async message => {
                if (message.command === 'webviewLoaded') {
                    console.log('[SnapTeX] Webview reloaded.');
                    this._renderer.resetState();
                    this.update();
                    this._onWebviewLoadedEmitter.fire();
                } else if (message.command === 'revealLine') {
                    this.handleRevealLine(message);
                } else if (message.command === 'syncScroll') {
                    vscode.commands.executeCommand('snaptex.internal.syncScroll', message.index, message.ratio);
                } else if (message.command === 'requestPdf') {
                    await this.handlePdfRequest(message);
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

    // Prefer webview resource URIs for PDFs, with base64 retained as a fallback path.
    private async handlePdfRequest(message: any) {
        if (!this._sourceUri) {return;}

        const requestId = typeof message.id === 'string' ? message.id : '';
        const fail = (error: string) => {
            if (requestId) {
                this.postMessage({ command: 'pdfData', id: requestId, error });
            }
        };

        const cleanPath = normalizePdfRequestPath(message.path);
        if (!cleanPath) {
            fail('Invalid PDF path');
            return;
        }

        try {
            const docDir = vscode.Uri.joinPath(this._sourceUri, '..');
            const pdfUri = vscode.Uri.joinPath(docDir, ...cleanPath.split('/').filter(Boolean));
            const workspaceRoots = vscode.workspace.workspaceFolders?.map(folder => folder.uri) ?? [];
            if (!isUriWithinAllowedRoots(pdfUri, [docDir, ...workspaceRoots])) {
                fail('PDF path is outside the allowed roots');
                return;
            }

            // Check existence first
            if (await this._fileProvider.exists(pdfUri)) {
                if (getPdfRequestMode(message) === 'uri') {
                    const webviewUri = this._panel.webview.asWebviewUri(pdfUri);
                    this.postMessage({
                        command: 'pdfUri',
                        id: requestId,
                        uri: webviewUri.toString(),
                        path: cleanPath
                    });
                    return;
                }

                const fileData = await this._fileProvider.readBuffer(pdfUri);
                const base64 = uint8ToBase64(fileData);
                this.postMessage({
                    command: 'pdfData',
                    id: requestId,
                    data: base64
                });
            } else {
                console.warn(`[SnapTeX] PDF not found: ${pdfUri.toString()}`);
                fail('PDF not found');
            }
        } catch (e) {
            console.error('[SnapTeX] Failed to read PDF:', e);
            fail('Failed to read PDF');
        }
    }

    public postMessage(message: any) {
        this._panel.webview.postMessage(message);
    }

    private postWebviewConfig() {
        const config = vscode.workspace.getConfiguration('snaptex');
        this.postMessage({
            command: 'config',
            config: {
                autoScrollDelay: Math.max(0, config.get<number>('autoScrollDelay', 100)),
                debugMemory: config.get<boolean>('debugMemory', false)
            }
        });
    }

    private resolveUpdateUri(rootUri?: vscode.Uri): vscode.Uri | undefined {
        if (rootUri) {
            return rootUri;
        }

        const editor = vscode.window.activeTextEditor;
        if (editor) {
            return editor.document.uri;
        }

        return this._sourceUri;
    }

    /**
     * [UPDATED] Update logic to support subfiles.
     * @param rootUri If provided, forces rendering this specific file (the Root),
     * ignoring the currently active editor file.
     */
    public async update(rootUri?: vscode.Uri) {
        const docUri = this.resolveUpdateUri(rootUri);
        if (!docUri) { return; }

        this._pendingRootUri = docUri;
        if (this._updateRunning) {
            return;
        }

        this._updateRunning = true;
        try {
            while (this._pendingRootUri) {
                const nextUri = this._pendingRootUri;
                this._pendingRootUri = undefined;
                await this.updateOnce(nextUri);
            }
        } finally {
            this._updateRunning = false;
        }
    }

    private async updateOnce(docUri: vscode.Uri) {
        // Fetch text content (from open editor buffer if available, else from disk)
        let text = "";
        try {
            logHostMemory('before getText');
            const doc = await vscode.workspace.openTextDocument(docUri);
            text = doc.getText();
            logHostMemory('after getText');
        } catch (e) {
            console.warn(`[SnapTeX] Could not open document: ${docUri}`);
            return;
        }

        const filename = getBasename(docUri);
        this._panel.title = `𖧼 ${filename}`;

        // Update the panel's source of truth to the Root file
        this._sourceUri = docUri;

        const docDir = vscode.Uri.joinPath(this._sourceUri, '..');

        // [FIX] CRITICAL: Grant Webview access to the document's folder.
        // Without this, the Webview CANNOT load local images (PNG/JPG) due to security policies.
        // We update the options dynamically for the current document.
        const mediaRoot = vscode.Uri.joinPath(this._extensionUri, 'media');
        this._panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri, mediaRoot, docDir]
        };
        this.postWebviewConfig();

        if (this._currentDocument) {
            const parseResult = await this._currentDocument.parse(this._sourceUri, text);
            logHostMemory('after parse');

            this._currentDocument.applyResult(parseResult);
            const payload = this._renderer.render(this._currentDocument);
            logHostMemory('after render');
            this._currentDocument.releaseTextContent();

            const fixPaths = (html: string) => {
                // Fix standard images (LOCAL_IMG)
                // Note: PDF requests (data-req-path) are ignored here and handled by JS
                let fixed = html.replace(/(src|data-pdf-src)="LOCAL_IMG:([^"]+)"/g, (match, attr, relPath) => {
                    let normalizedPath = relPath.replace(/\\/g, '/');
                    if (normalizedPath.startsWith('./')) { normalizedPath = normalizedPath.substring(2); }

                    // Use path segments to safely join
                    const pathSegments = normalizedPath.split('/');
                    const fullUri = vscode.Uri.joinPath(docDir, ...pathSegments);

                    const webviewUri = this._panel.webview.asWebviewUri(fullUri);
                    return `${attr}="${webviewUri.toString()}"`;
                });
                return fixed;
            };

            if (payload.type === 'full' && payload.htmls) {

                let fullHtml = '';
                for (const html of payload.htmls) {
                    fullHtml += fixPaths(html);
                }
                logHostMemory('after fixPaths/fullHtml');

                let binaryHtml: Uint8Array;
                if (typeof Buffer !== 'undefined') {
                    binaryHtml = Buffer.from(fullHtml);
                } else {
                    const encoder = new TextEncoder();
                    binaryHtml = encoder.encode(fullHtml);
                }
                logHostMemory('after Buffer');
                const { htmls, ...payloadWithoutHtmls } = payload;

                this._panel.webview.postMessage({
                    command: 'update_binary',
                    payload: payloadWithoutHtmls,
                    binaryData: binaryHtml
                });
                logHostMemory('after postMessage');
            } else {
                if (payload.type === 'patch' && payload.htmls) {
                    payload.htmls = payload.htmls.map(h => fixPaths(h));
                }
                logHostMemory('after fixPaths');
                this._panel.webview.postMessage({ command: 'update', payload });
                logHostMemory('after postMessage');
            }
        }
    }

    private async _getWebviewSkeleton(): Promise<string> {
        // Use joinPath instead of path.join
        const toUri = (p: string) => this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, p));

        const katexCssUri = toUri('media/vendor/katex/katex.min.css');
        const styleUri = toUri('media/preview-style.css');
        const pdfJsUri = toUri('media/vendor/pdfjs/pdf.mjs');
        const pdfWorkerUri = toUri('media/vendor/pdfjs/pdf.worker.mjs');

        // Added TikZJax URIs
        const tikzJaxJsUri = toUri('media/vendor/tikzjax/tikzjax.js');
        const tikzJaxCssUri = toUri('media/vendor/tikzjax/fonts.css');

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
            .replace(/{{pdfWorkerUri}}/g, pdfWorkerUri.toString())
            // Inject the TikZJax variables
            .replace(/{{tikzJaxJsUri}}/g, tikzJaxJsUri.toString())
            .replace(/{{tikzJaxCssUri}}/g, tikzJaxCssUri.toString());
    }

    public dispose() {
        TexPreviewPanel.currentPanel = undefined;
        this._onWebviewLoadedEmitter.dispose();
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }
}
