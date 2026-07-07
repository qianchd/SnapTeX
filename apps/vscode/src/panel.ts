import * as vscode from 'vscode';
import type { IFileProvider } from '../../../src/file-provider';
import { decodeHtmlAttribute, getBasename, normalizeUri } from '../../../src/utils';
import { fillPreviewHtmlTemplate } from '../../../src/preview-template';
import type { PreviewUpdateService } from '../../../src/preview-update-service';
import type { RenderPayload } from '../../../src/types';
import {
    assertNever,
    ExtensionToWebviewCommand,
    isWebviewToExtensionMessage,
    WebviewToExtensionCommand,
    type ExtensionToWebviewMessage,
    type RequestBlockHtmlMessage,
    type RequestPdfMessage,
    type RevealLineMessage
} from '../../../src/webview-messages';

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

function isDebugMemoryEnabled(): boolean {
    return vscode.workspace.getConfiguration('snaptex').get<boolean>('debugMemory', false);
}

function sumStringChars(values: readonly string[]): number {
    return values.reduce((sum, value) => sum + value.length, 0);
}

function logPayloadStats(label: string, payload: RenderPayload) {
    if (!isDebugMemoryEnabled()) {
        return;
    }

    const htmls = payload.htmls ?? [];
    const dirtyBlocks = payload.dirtyBlocks ? Object.values(payload.dirtyBlocks) : [];
    console.log(`[SnapTeX][payload] ${label}`, {
        type: payload.type,
        payloadKind: payload.blocks ? `${payload.type}:blocks` : `${payload.type}:htmls`,
        blocks: payload.blocks?.length ?? 0,
        htmls: htmls.length,
        htmlChars: sumStringChars(htmls),
        dirtyBlocks: dirtyBlocks.length,
        dirtyBlockChars: sumStringChars(dirtyBlocks),
        numberingBlocks: Object.keys(payload.numbering.blocks).length,
        labels: Object.keys(payload.numbering.labels).length
    });
}

export function getVirtualMode(config = vscode.workspace.getConfiguration('snaptex')): boolean {
    return config.get<boolean>('virtualMode', true);
}

export function normalizePdfRequestPath(input: unknown): string | undefined {
    if (typeof input !== 'string') {
        return undefined;
    }

    const cleanPath = input.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');

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

/**
 * Owns the VS Code webview panel and bridges renderer payloads to webview
 * messages. File system access, resource URI conversion, and request validation
 * live here; LaTeX parsing and HTML rendering stay in document.ts/renderer.ts.
 */
export class TexPreviewPanel {
    public static currentPanel: TexPreviewPanel | undefined;
    public static readonly viewType = 'texPreview';
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private readonly _fileProvider: IFileProvider<vscode.Uri>;
    private readonly _updateService: PreviewUpdateService<vscode.Uri>;

    private _sourceUri: vscode.Uri | undefined;
    private _updateRunning = false;
    private _pendingRootUri: vscode.Uri | undefined;
    private _webviewReady = false;

    public static createOrShow(
        extensionUri: vscode.Uri,
        fileProvider: IFileProvider<vscode.Uri>,
        updateService: PreviewUpdateService<vscode.Uri>
    ): TexPreviewPanel {
        const editor = vscode.window.activeTextEditor;
        const column = editor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
        if (TexPreviewPanel.currentPanel) {
            TexPreviewPanel.currentPanel._panel.reveal(column);
            return TexPreviewPanel.currentPanel;
        }

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

        TexPreviewPanel.currentPanel = new TexPreviewPanel(panel, extensionUri, fileProvider, updateService);
        return TexPreviewPanel.currentPanel;
    }

    public static revive(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        fileProvider: IFileProvider<vscode.Uri>,
        updateService: PreviewUpdateService<vscode.Uri>
    ) {
        if (TexPreviewPanel.currentPanel) {
            TexPreviewPanel.currentPanel.dispose();
        }
        const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [extensionUri, mediaRoot]
        };

        TexPreviewPanel.currentPanel = new TexPreviewPanel(panel, extensionUri, fileProvider, updateService);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        fileProvider: IFileProvider<vscode.Uri>,
        updateService: PreviewUpdateService<vscode.Uri>
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._fileProvider = fileProvider;
        this._updateService = updateService;

        this._updateService.resetState();

        this._panel.webview.onDidReceiveMessage(
            async message => {
                if (!isWebviewToExtensionMessage(message)) {
                    console.warn('[SnapTeX] Ignoring malformed webview message.');
                    return;
                }

                switch (message.command) {
                    case WebviewToExtensionCommand.WebviewLoaded:
                        console.log('[SnapTeX] Webview reloaded.');
                        this._webviewReady = true;
                        this._updateService.resetState();
                        void this.update(this._pendingRootUri);
                        break;
                    case WebviewToExtensionCommand.RevealLine:
                        this.handleRevealLine(message);
                        break;
                    case WebviewToExtensionCommand.SyncScroll:
                        vscode.commands.executeCommand('snaptex.internal.syncScroll', message.index, message.ratio);
                        break;
                    case WebviewToExtensionCommand.RequestPdf:
                        await this.handlePdfRequest(message);
                        break;
                    case WebviewToExtensionCommand.RequestBlockHtml:
                        this.handleBlockHtmlRequest(message);
                        break;
                    default:
                        assertNever(message);
                }
            },
            null,
            this._disposables
        );

        void this._initWebviewHtml();
        void this.update();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    private async _initWebviewHtml() {
        this._webviewReady = false;
        this._panel.webview.html = await this._getWebviewSkeleton();
    }

    /**
     * Forwards a webview block/ratio reveal request to the extension command.
     */
    private handleRevealLine(message: RevealLineMessage) {
        if (this._sourceUri) {
            vscode.commands.executeCommand(
                'snaptex.internal.revealLine',
                this._sourceUri,
                message.index,
                message.ratio,
                message.anchors,
                message.viewRatio
            );
        }
    }

    /**
     * Resolves a validated relative PDF path to a webview URI.
     */
    private async handlePdfRequest(message: RequestPdfMessage) {
        if (!this._sourceUri) {return;}

        const fail = (error: string) => {
            this.postMessage({ command: ExtensionToWebviewCommand.PdfUri, id: message.id, error });
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

            if (await this._fileProvider.exists(pdfUri)) {
                const webviewUri = this._panel.webview.asWebviewUri(pdfUri);
                this.postMessage({
                    command: ExtensionToWebviewCommand.PdfUri,
                    id: message.id,
                    uri: webviewUri.toString(),
                    path: cleanPath
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

    private fixHtmlPaths(html: string): string {
        if (!this._sourceUri) { return html; }

        const docDir = vscode.Uri.joinPath(this._sourceUri, '..');
        return html.replace(/(src|data-pdf-src)="LOCAL_IMG:([^"]+)"/g, (_match, attr, relPath) => {
            let normalizedPath = decodeHtmlAttribute(relPath).replace(/\\/g, '/');
            if (normalizedPath.startsWith('./')) { normalizedPath = normalizedPath.substring(2); }

            const pathSegments = normalizedPath.split('/');
            const fullUri = vscode.Uri.joinPath(docDir, ...pathSegments);
            const webviewUri = this._panel.webview.asWebviewUri(fullUri);
            return `${attr}="${webviewUri.toString()}"`;
        });
    }

    private handleBlockHtmlRequest(message: RequestBlockHtmlMessage) {
        const id = message.id;
        const index = message.index;
        const requestedHash = message.hash;

        if (!id || Number.isNaN(index)) {
            return;
        }

        const block = this._updateService.renderBlockByIndex(index);
        if (!block) {
            this.postMessage({ command: ExtensionToWebviewCommand.BlockHtml, id, index, error: 'Block not found' });
            return;
        }

        if (requestedHash && block.hash !== requestedHash) {
            this.postMessage({ command: ExtensionToWebviewCommand.BlockHtml, id, index, hash: block.hash, error: 'Block hash changed' });
            return;
        }

        if (block.html === undefined) {
            this.postMessage({ command: ExtensionToWebviewCommand.BlockHtml, id, index, hash: block.hash, error: 'Block not found' });
            return;
        }

        this.postMessage({
            command: ExtensionToWebviewCommand.BlockHtml,
            id,
            index,
            hash: block.hash,
            html: this.fixHtmlPaths(block.html)
        });
    }

    public postMessage(message: ExtensionToWebviewMessage) {
        this._panel.webview.postMessage(message);
    }

    private postWebviewConfig() {
        const config = vscode.workspace.getConfiguration('snaptex');
        this.postMessage({
            command: ExtensionToWebviewCommand.Config,
            config: {
                autoScrollDelay: Math.max(0, config.get<number>('autoScrollDelay', 100)),
                debugMemory: config.get<boolean>('debugMemory', false),
                virtualMode: getVirtualMode(config)
            }
        });
    }

    private resolveUpdateUri(): vscode.Uri | undefined {
        return vscode.window.activeTextEditor?.document.uri ?? this._sourceUri;
    }

    /**
     * Queues and serializes preview updates. The webview must send WebviewLoaded
     * before parsing begins, which avoids blank previews during VS Code startup.
     */
    public async update(rootUri?: vscode.Uri) {
        const docUri = rootUri ?? this._pendingRootUri ?? this.resolveUpdateUri();
        if (!docUri) { return; }

        this._pendingRootUri = docUri;
        if (!this._webviewReady) {
            return;
        }

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

        const previousSourceUri = this._sourceUri;
        const sourceChanged = previousSourceUri !== undefined && normalizeUri(previousSourceUri) !== normalizeUri(docUri);

        this._sourceUri = docUri;
        if (sourceChanged) {
            this._updateService.resetState();
        }

        const docDir = vscode.Uri.joinPath(this._sourceUri, '..');

        const mediaRoot = vscode.Uri.joinPath(this._extensionUri, 'media');
        this._panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri, mediaRoot, docDir]
        };
        this.postWebviewConfig();

        const virtualizeBlocks = getVirtualMode();
        const payload = await this._updateService.render(this._sourceUri, text, {
            deferFullHtml: virtualizeBlocks,
            trace: logHostMemory,
            transformHtml: html => this.fixHtmlPaths(html)
        });
        text = "";
        logPayloadStats('before postMessage', payload);
        this.postMessage({ command: ExtensionToWebviewCommand.Update, payload });
        logHostMemory('after postMessage');
    }

    private async _getWebviewSkeleton(): Promise<string> {
        const toUri = (p: string) => this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, p));

        const katexCssUri = toUri('media/vendor/katex/katex.min.css');
        const styleUri = toUri('media/preview-style.css');
        const webviewMainUri = toUri('media/webview-main.js');
        const webviewPdfUri = toUri('media/webview-pdf.js');
        const pdfJsUri = toUri('media/vendor/pdfjs/pdf.mjs');
        const pdfWorkerUri = toUri('media/vendor/pdfjs/pdf.worker.mjs');

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

        const cspSource = this._panel.webview.cspSource;
        const cspMeta = `<meta http-equiv="Content-Security-Policy" content="
        default-src 'none';
        script-src ${cspSource} 'unsafe-inline' 'unsafe-eval' blob:;
        worker-src ${cspSource} blob:;
        style-src ${cspSource} 'unsafe-inline';
        font-src ${cspSource} data:;
        img-src ${cspSource} data: blob:;
        connect-src ${cspSource} blob:;
    ">`;

        return fillPreviewHtmlTemplate(htmlContent, {
            cspMeta,
            styleLinks: [
                katexCssUri.toString(),
                styleUri.toString()
            ],
            bodyData: {
                'data-tikz-jax-js-uri': tikzJaxJsUri.toString(),
                'data-tikz-jax-css-uri': tikzJaxCssUri.toString(),
                'data-pdf-js-uri': pdfJsUri.toString(),
                'data-pdf-worker-uri': pdfWorkerUri.toString()
            },
            bridgeScript: '<script>window.snaptexPreviewBridge=acquireVsCodeApi();</script>',
            scripts: [
                webviewMainUri.toString(),
                webviewPdfUri.toString()
            ]
        });
    }

    public dispose() {
        TexPreviewPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }
}
