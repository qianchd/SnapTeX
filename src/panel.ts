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

    private _sourceUri: vscode.Uri | undefined;

    public get panel() {
        return this._panel;
    }

    public get sourceUri() {
        return this._sourceUri;
    }

    public static createOrShow(extensionPath: string, renderer: SmartRenderer): TexPreviewPanel {
        const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;

        if (TexPreviewPanel.currentPanel) {
            TexPreviewPanel.currentPanel._panel.reveal(column);
            return TexPreviewPanel.currentPanel;
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
        return TexPreviewPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionPath: string, renderer: SmartRenderer) {
        this._panel = panel;
        this._extensionPath = extensionPath;
        this._renderer = renderer;

        this._renderer.resetState();
        this._panel.webview.html = this._getWebviewSkeleton();
        this.update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public postMessage(message: any) {
        this._panel.webview.postMessage(message);
    }

    public update() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }

        this._sourceUri = editor.document.uri;

        const text = editor.document.getText();
        const payload = this._renderer.render(text);
        this._panel.webview.postMessage({ command: 'update', payload });
    }

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
                const vscode = acquireVsCodeApi();
                const contentRoot = document.getElementById('content-root');
                const root = document.documentElement;

                // --- Scroll State Management ---
                function saveScrollState() {
                    const blocks = document.querySelectorAll('.latex-block');
                    const scrollTop = window.scrollY;

                    // Find the first block that is currently visible in the viewport
                    for (const block of blocks) {
                        const rect = block.getBoundingClientRect();
                        // rect.bottom > 0 means the block is at least partially visible or below top
                        // rect.top <= window.innerHeight
                        if (rect.bottom > 0 && rect.top < window.innerHeight) {
                            const index = block.getAttribute('data-index');
                            // Calculate how far we are into this block (ratio)
                            // Offset is the distance from the block's top to the viewport top
                            const offset = -rect.top;
                            const ratio = offset / rect.height;

                            return { index, ratio, offset };
                        }
                    }
                    return null;
                }

                function restoreScrollState(state) {
                    if (!state || !state.index) return;

                    const block = document.querySelector('.latex-block[data-index="' + state.index + '"]');
                    if (block) {
                        // Calculate new scroll position: Element Top + (Height * Previous Ratio)
                        // This accounts for the block's height potentially changing after re-render
                        const newTop = block.getBoundingClientRect().top + window.scrollY;
                        // However, using the exact pixel offset often feels more natural if content didn't shift much
                        // But using ratio is safer for resizing. Let's try to restore the visual anchor.

                        let targetY;
                        // If we had a specific offset, try to respect the relative position
                        if (state.ratio >= 0) {
                             targetY = newTop + (block.offsetHeight * state.ratio);
                        } else {
                             targetY = newTop;
                        }

                        // Scroll instantly
                        window.scrollTo({ top: targetY, behavior: 'auto' });
                    }
                }

                // [Updated] Robust Highlighting Logic
                function highlightTextInNode(rootElement, text) {
                    if (!text || text.length < 3) return false;

                    const walker = document.createTreeWalker(
                        rootElement,
                        NodeFilter.SHOW_TEXT,
                        {
                            acceptNode: (node) => {
                                if (node.parentElement && node.parentElement.closest('.katex')) {
                                    return NodeFilter.FILTER_REJECT;
                                }
                                return NodeFilter.FILTER_ACCEPT;
                            }
                        }
                    );

                    let node;
                    while (node = walker.nextNode()) {
                        const val = node.nodeValue;
                        const index = val.indexOf(text);

                        if (index >= 0) {
                            const range = document.createRange();
                            range.setStart(node, index);
                            range.setEnd(node, index + text.length);

                            const span = document.createElement('span');
                            span.className = 'highlight-word';
                            range.surroundContents(span);

                            span.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });

                            setTimeout(() => {
                                const parent = span.parentNode;
                                if (parent) {
                                    parent.replaceChild(document.createTextNode(span.textContent), span);
                                    parent.normalize();
                                }
                            }, 3000);
                            return true;
                        }
                    }
                    return false;
                }

                window.addEventListener('message', event => {
                    const { command, payload, index, ratio, anchor } = event.data;

                    if (command === 'update') {
                        if (payload.type === 'full') {
                            // 1. Capture scroll state before nuking DOM
                            const scrollState = saveScrollState();

                            document.body.classList.add('preload-mode');
                            contentRoot.innerHTML = payload.html;

                            document.fonts.ready.then(() => {
                                requestAnimationFrame(() => {
                                    requestAnimationFrame(() => {
                                        const fullHeight = document.body.scrollHeight;
                                        const count = contentRoot.childElementCount || 1;
                                        const avgHeight = fullHeight / count;
                                        root.style.setProperty('--avg-height', avgHeight.toFixed(2) + 'px');

                                        // 2. Restore scroll state
                                        restoreScrollState(scrollState);

                                        document.body.classList.remove('preload-mode');
                                    });
                                });
                            });
                        } else if (payload.type === 'patch') {
                            const { start, deleteCount, htmls = [], shift = 0 } = payload;
                            const targetIndex = start + deleteCount;
                            const referenceNode = contentRoot.children[targetIndex] || null;

                            // 1. Remove old blocks
                            for (let i = 0; i < deleteCount; i++) {
                                if (contentRoot.children[start]) contentRoot.removeChild(contentRoot.children[start]);
                            }

                            // 2. Insert new blocks
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

                            // 3. Shift indices
                            if (shift !== 0) {
                                let node = contentRoot.children[start + htmls.length];
                                while (node) {
                                    const oldIdx = parseInt(node.getAttribute('data-index'));
                                    if (!isNaN(oldIdx)) {
                                        node.setAttribute('data-index', oldIdx + shift);
                                    }
                                    node = node.nextElementSibling;
                                }
                            }
                        }
                    }
                    else if (command === 'scrollToBlock') {
                        const target = document.querySelector('.latex-block[data-index="' + index + '"]');
                        if (target) {
                            target.classList.add('jump-highlight');
                            setTimeout(() => target.classList.remove('jump-highlight'), 2000);

                            let preciseFound = false;
                            if (anchor) {
                                preciseFound = highlightTextInNode(target, anchor);
                            }

                            if (!preciseFound) {
                                const rect = target.getBoundingClientRect();
                                const absoluteTop = rect.top + window.scrollY;
                                const offset = (ratio || 0) * rect.height;
                                const targetY = absoluteTop + offset - (window.innerHeight / 2);
                                window.scrollTo({
                                    top: targetY,
                                    behavior: 'smooth'
                                });
                            }
                        }
                    }
                });

                document.addEventListener('dblclick', event => {
                    const block = event.target.closest('.latex-block');
                    if (block) {
                        const index = block.getAttribute('data-index');
                        if (index !== null) {
                            const rect = block.getBoundingClientRect();
                            const relativeY = event.clientY - rect.top;
                            const ratio = Math.max(0, Math.min(1, relativeY / rect.height));

                            let anchorText = "";
                            const selection = window.getSelection();
                            if (selection && selection.toString().trim().length > 0) {
                                anchorText = selection.toString().trim();
                            } else if (document.caretRangeFromPoint) {
                                const range = document.caretRangeFromPoint(event.clientX, event.clientY);
                                if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
                                    const text = range.startContainer.textContent;
                                    const offset = range.startOffset;
                                    let start = offset;
                                    let end = offset;
                                    while (start > 0 && /\\S/.test(text[start - 1])) start--;
                                    while (end < text.length && /\\S/.test(text[end])) end++;
                                    if (end > start) {
                                        anchorText = text.substring(start, end);
                                    }
                                }
                            }

                            vscode.postMessage({
                                command: 'revealLine',
                                index: parseInt(index),
                                ratio: ratio,
                                anchor: anchorText
                            });
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