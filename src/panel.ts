import * as vscode from 'vscode';
import * as path from 'path';
import { SmartRenderer } from './renderer';

export class TexPreviewPanel {
    public static currentPanel: TexPreviewPanel | undefined;
    public static readonly viewType = 'texPreview';
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionPath: string;
    private _disposables: vscode.Disposable[] = [];
    private _renderer: SmartRenderer;

    public static createOrShow(extensionPath: string, renderer: SmartRenderer) {
        const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;

        if (TexPreviewPanel.currentPanel) {
            TexPreviewPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            TexPreviewPanel.viewType,
            'TeX Preview',
            column,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.file(extensionPath),
                    vscode.Uri.file(path.join(extensionPath, 'node_modules'))
                ]
            }
        );
        TexPreviewPanel.currentPanel = new TexPreviewPanel(panel, extensionPath, renderer);
    }

    private constructor(panel: vscode.WebviewPanel, extensionPath: string, renderer: SmartRenderer) {
        this._panel = panel;
        this._extensionPath = extensionPath;
        this._renderer = renderer;

        // [Fix] Reset state on initialization
        this._renderer.resetState();

        this._panel.webview.html = this._getWebviewSkeleton();

        // Ensure initial load
        this.update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public update() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        const text = editor.document.getText();
        const payload = this._renderer.render(text);
        this._panel.webview.postMessage({ command: 'update', payload });
    }

    // [Ported from ext-old] Accurately find KaTeX local path
    private getKatexPaths() {
        let katexMainPath = "";
        try {
            katexMainPath = require.resolve('katex');
        } catch (e) {
            try {
                const pkgPath = require.resolve('@iktakahiro/markdown-it-katex/package.json');
                const pkgDir = path.dirname(pkgPath);
                katexMainPath = path.join(pkgDir, 'node_modules', 'katex', 'dist', 'katex.min.css');
            } catch (e2) {
                katexMainPath = path.join(this._extensionPath, 'node_modules', '@iktakahiro', 'markdown-it-katex', 'node_modules', 'katex', 'dist', 'katex.min.css');
            }
        }
        let distDir = katexMainPath.includes('dist') ? path.dirname(katexMainPath) : path.join(path.dirname(katexMainPath), 'dist');
        return {
            cssFile: vscode.Uri.file(path.join(distDir, 'katex.min.css')),
            distDirUri: this._panel.webview.asWebviewUri(vscode.Uri.file(distDir))
        };
    }

    private _getWebviewSkeleton() {
        const paths = this.getKatexPaths();
        const katexCssUri = this._panel.webview.asWebviewUri(paths.cssFile);
        const stylePath = vscode.Uri.file(path.join(this._extensionPath, 'media', 'preview-style.css'));
        const styleUri = this._panel.webview.asWebviewUri(stylePath);
        const baseUri = paths.distDirUri + '/';

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <base href="${baseUri}">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this._panel.webview.cspSource} 'unsafe-inline'; font-src ${this._panel.webview.cspSource} data:; script-src ${this._panel.webview.cspSource} 'unsafe-inline' https://unpkg.com;">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link rel="stylesheet" href="${katexCssUri}">
                <link rel="stylesheet" href="${styleUri}">
            </head>
            <body>
            <div id="content-root"></div>
            <script>
                const contentRoot = document.getElementById('content-root');
                const root = document.documentElement;

                // --- Message handling ---
                window.addEventListener('message', event => {
                    const { command, payload } = event.data;
                    if (command === 'update') {
                        if (payload.type === 'full') {
                            console.log("full update");

                            // 1. Enable global rendering
                            document.body.classList.add('preload-mode');

                            // [Step C] Write content
                            contentRoot.innerHTML = payload.html;

                            // [Step D] Wait for fonts + Force reflow
                            document.fonts.ready.then(() => {
                                requestAnimationFrame(() => {
                                    requestAnimationFrame(() => {
                                        const fullHeight = document.body.scrollHeight;
                                        const count = contentRoot.childElementCount || 1;

                                        // Update base values (for initial CSS variable setting)
                                        const avgHeight = fullHeight / count;

                                        const avgStr = avgHeight.toFixed(2);
                                        root.style.setProperty('--avg-height', avgStr + 'px');

                                        document.body.classList.remove('preload-mode');
                                        console.log('[Preview] Full render done. Avg set to:', avgStr);
                                    });
                                });
                            });
                        } else if (payload.type === 'patch') {
                            console.log("local update");
                            // Patch logic
                            const { start, deleteCount, htmls = [] } = payload;
                            const targetIndex = start + deleteCount;
                            const referenceNode = contentRoot.children[targetIndex] || null;

                            for (let i = 0; i < deleteCount; i++) {
                                if (contentRoot.children[start]) contentRoot.removeChild(contentRoot.children[start]);
                            }

                            if (htmls.length > 0) {
                                const fragment = document.createDocumentFragment();
                                const tempDiv = document.createElement('div');
                                htmls.forEach(html => {
                                    tempDiv.innerHTML = html;
                                    const node = tempDiv.firstElementChild;
                                    if (node) fragment.appendChild(node);
                                });
                                contentRoot.insertBefore(fragment, referenceNode);
                            }
                        }
                    }
                });

                // Jump listener (Keep unchanged)
                document.addEventListener('click', e => {
                    const target = e.target.closest('a');
                    if (target && target.getAttribute('href')?.startsWith('#')) {
                        const id = target.getAttribute('href').substring(1);
                        const element = document.getElementById(id);
                        if (element) {
                            e.preventDefault();
                            const parentBlock = element.closest('.latex-block');
                            (parentBlock || element).scrollIntoView({ behavior: 'smooth', block: 'center' });
                            if (parentBlock) {
                                parentBlock.classList.add('jump-highlight');
                                setTimeout(() => parentBlock.classList.remove('jump-highlight'), 2000);
                            }
                        }
                    }
                });
            </script>
            </body>
            </html>`;
    }

    public dispose() {
        TexPreviewPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }
}