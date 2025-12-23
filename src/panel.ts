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

        // If we already have a panel, show it.
        if (TexPreviewPanel.currentPanel) {
            TexPreviewPanel.currentPanel._panel.reveal(column);
            return TexPreviewPanel.currentPanel;
        }

        // Define the roots allowed to be loaded in the Webview
        // IMPORTANT: We must include the 'media' directory where our assets (KaTeX, PDF.js) live.
        const localResourceRoots = [
            vscode.Uri.file(extensionPath),
            vscode.Uri.file(path.join(extensionPath, 'media'))
        ];

        // Also allow access to the current workspace folders (for images/PDFs in the user's project)
        if (vscode.workspace.workspaceFolders) {
            vscode.workspace.workspaceFolders.forEach(folder => {
                localResourceRoots.push(folder.uri);
            });
        }

        const panel = vscode.window.createWebviewPanel(
            TexPreviewPanel.viewType,
            'TeX Preview',
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
                } else if (message.command === 'revealLine') {
                    // Forward reveal line command to extension logic (handled usually in extension.ts via commands,
                    // but here we might just emit an event if needed. For now, assuming basic sync works).
                    // Actually, typically the extension listens to the panel, but here we just log or handle if implemented.
                    // If you have logic to sync BACK to the editor:
                    this.handleRevealLine(message);
                }
            },
            null,
            this._disposables
        );

        // Initial update
        this.update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    /**
     * Handle syncing from Preview -> Editor
     */
    private handleRevealLine(message: any) {
        const { index, ratio, anchor } = message;
        if (this._sourceUri) {
             // Logic to find the editor and reveal line could go here or via command dispatch
             vscode.commands.executeCommand('snaptex.internal.revealLine', this._sourceUri, index, ratio, anchor);
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
            // console.warn('[SnapTeX] Cannot find source document for update.');
            return;
        }

        this._sourceUri = doc.uri;
        const docDir = path.dirname(this._sourceUri.fsPath);
        const text = doc.getText();

        // Render the LaTeX content
        let payload = this._renderer.render(text);

        // Helper to fix local image paths in the HTML
        const fixPaths = (html: string) => {
            // Fix standard images: src="LOCAL_IMG:..."
            let fixed = html.replace(/src="LOCAL_IMG:([^"]+)"/g, (match, relPath) => {
                const fullPath = path.isAbsolute(relPath) ? relPath : path.join(docDir, relPath);
                const uri = this._panel.webview.asWebviewUri(vscode.Uri.file(fullPath));
                return `src="${uri}"`;
            });

            // Fix PDF canvas sources: data-pdf-src="LOCAL_IMG:..."
            fixed = fixed.replace(/data-pdf-src="LOCAL_IMG:([^"]+)"/g, (match, relPath) => {
                const fullPath = path.isAbsolute(relPath) ? relPath : path.join(docDir, relPath);
                const uri = this._panel.webview.asWebviewUri(vscode.Uri.file(fullPath));
                return `data-pdf-src="${uri}"`;
            });
            return fixed;
        };

        // Apply path fix to the payload
        if (payload.type === 'full' && payload.html) {
            payload.html = fixPaths(payload.html);
        } else if (payload.type === 'patch' && payload.htmls) {
            payload.htmls = payload.htmls.map(h => fixPaths(h));
        }

        // Send the update payload to the Webview
        this._panel.webview.postMessage({ command: 'update', payload });
    }

    private _getWebviewSkeleton() {
        // [FIX] Correctly resolve paths to the 'media/vendor' directory.
        // We DO NOT resolve 'node_modules' here because it won't exist in the packaged extension.

        // 1. KaTeX CSS
        const katexPath = vscode.Uri.file(
            path.join(this._extensionPath, 'media', 'vendor', 'katex', 'katex.min.css')
        );
        const katexCssUri = this._panel.webview.asWebviewUri(katexPath);

        // 2. Custom Preview CSS
        const stylePath = vscode.Uri.file(path.join(this._extensionPath, 'media', 'preview-style.css'));
        const styleUri = this._panel.webview.asWebviewUri(stylePath);

        // 3. PDF.js Main Script
        const pdfJsPath = vscode.Uri.file(path.join(this._extensionPath, 'media', 'vendor', 'pdfjs', 'pdf.mjs'));
        const pdfJsUri = this._panel.webview.asWebviewUri(pdfJsPath);

        // 4. PDF.js Worker Script
        const pdfWorkerPath = vscode.Uri.file(path.join(this._extensionPath, 'media', 'vendor', 'pdfjs', 'pdf.worker.mjs'));
        const pdfWorkerUri = this._panel.webview.asWebviewUri(pdfWorkerPath);

        // [FIX] Removed <base> tag to allow KaTeX fonts to load relatively to the CSS file.
        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="
                    default-src 'none';
                    script-src ${this._panel.webview.cspSource} 'unsafe-inline' blob: https://unpkg.com;
                    worker-src ${this._panel.webview.cspSource} blob:;
                    style-src ${this._panel.webview.cspSource} 'unsafe-inline';
                    font-src ${this._panel.webview.cspSource} data:;
                    img-src ${this._panel.webview.cspSource} https: data:;
                    connect-src ${this._panel.webview.cspSource} blob: https:;
                ">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link rel="stylesheet" href="${katexCssUri}">
                <link rel="stylesheet" href="${styleUri}">
                <title>SnapTeX Preview</title>
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

                    for (const block of blocks) {
                        const rect = block.getBoundingClientRect();
                        // Find the first visible block
                        if (rect.bottom > 0 && rect.top < window.innerHeight) {
                            const index = block.getAttribute('data-index');
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
                        const newTop = block.getBoundingClientRect().top + window.scrollY;
                        let targetY;

                        // Calculate target Y based on previous ratio
                        if (state.ratio >= 0) {
                             targetY = newTop + (block.offsetHeight * state.ratio);
                        } else {
                             targetY = newTop;
                        }

                        window.scrollTo({ top: targetY, behavior: 'auto' });
                    }
                }

                // --- Text Highlighting Logic ---
                function highlightTextInNode(rootElement, text) {
                    if (!text || text.length < 3) return false;

                    const walker = document.createTreeWalker(
                        rootElement,
                        NodeFilter.SHOW_TEXT,
                        {
                            acceptNode: (node) => {
                                // Skip math content to prevent breaking KaTeX rendering
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

                            // Remove highlight after animation
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

                // --- Smart DOM Update (Diffing) ---
                function smartFullUpdate(newHtml) {
                    const parser = new DOMParser();
                    const newDoc = parser.parseFromString(newHtml, 'text/html');
                    const newElements = Array.from(newDoc.body.children);
                    const oldElements = Array.from(contentRoot.children);

                    const maxLen = Math.max(newElements.length, oldElements.length);

                    for (let i = 0; i < maxLen; i++) {
                        const newEl = newElements[i];
                        const oldEl = oldElements[i];

                        if (!newEl) {
                            // Element deleted
                            if (oldEl) oldEl.remove();
                            continue;
                        }
                        if (!oldEl) {
                            // Element added
                            contentRoot.appendChild(newEl);
                            continue;
                        }

                        // Compare outerHTML (content + attributes)
                        if (oldEl.outerHTML !== newEl.outerHTML) {
                            oldEl.replaceWith(newEl);
                        }
                    }
                }

                // --- Message Listener ---
                window.addEventListener('message', event => {
                    const { command, payload, index, ratio, anchor } = event.data;

                    if (command === 'update') {
                        if (payload.type === 'full') {
                            // 1. Save scroll state
                            const scrollState = saveScrollState();

                            document.body.classList.add('preload-mode');
                            smartFullUpdate(payload.html);

                            // 2. Wait for fonts to load before calculating scroll position
                            document.fonts.ready.then(() => {
                                requestAnimationFrame(() => {
                                    requestAnimationFrame(() => {
                                        // Update dynamic CSS variable if needed
                                        const fullHeight = document.body.scrollHeight;
                                        const count = contentRoot.childElementCount || 1;
                                        const avgHeight = fullHeight / count;
                                        root.style.setProperty('--avg-height', avgHeight.toFixed(2) + 'px');

                                        // 3. Restore scroll state
                                        restoreScrollState(scrollState);

                                        document.body.classList.remove('preload-mode');
                                    });
                                });
                            });
                        } else if (payload.type === 'patch') {
                            // Handle partial updates
                            const { start, deleteCount, htmls = [], shift = 0 } = payload;
                            const targetIndex = start + deleteCount;
                            const referenceNode = contentRoot.children[targetIndex] || null;

                            // Remove old blocks
                            for (let i = 0; i < deleteCount; i++) {
                                if (contentRoot.children[start]) contentRoot.removeChild(contentRoot.children[start]);
                            }

                            // Insert new blocks
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

                            // Shift indices of subsequent blocks
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
                        // Handle Sync: Editor -> Preview
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

                // --- Sync: Preview -> Editor (Double Click) ---
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
                                    // Expand selection to word boundaries
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

                // Signal that the webview is ready
                vscode.postMessage({ command: 'webviewLoaded' });
            </script>

            <script type="module">
                import * as pdfjsLib from '${pdfJsUri}';
                pdfjsLib.GlobalWorkerOptions.workerSrc = '${pdfWorkerUri}';

                window.renderPdfToCanvas = async (pdfUri, canvasId) => {
                    try {
                        const canvas = document.getElementById(canvasId);
                        if (!canvas) return;

                        // Prevent duplicate rendering
                        if (canvas.getAttribute('data-rendering') === 'true') return;
                        canvas.setAttribute('data-rendering', 'true');

                        const loadingTask = pdfjsLib.getDocument(pdfUri);
                        const pdf = await loadingTask.promise;
                        const page = await pdf.getPage(1);

                        // High quality scale
                        const scale = 3;
                        const viewport = page.getViewport({ scale: scale });

                        // Resize canvas only if dimensions changed (prevents flickering)
                        if (canvas.width !== viewport.width || canvas.height !== viewport.height) {
                            canvas.height = viewport.height;
                            canvas.width = viewport.width;
                        }

                        const context = canvas.getContext('2d');
                        await page.render({ canvasContext: context, viewport: viewport }).promise;

                        canvas.removeAttribute('data-rendering');
                        // Mark as rendered to prevent unnecessary re-renders in update loop
                        canvas.setAttribute('data-rendered-uri', pdfUri);

                    } catch (error) {
                        console.error('PDF render error:', error);
                        const c = document.getElementById(canvasId);
                        if(c) c.removeAttribute('data-rendering');
                    }
                };

                window.addEventListener('message', event => {
                    if (event.data.command === 'update') {
                        // Check for PDF canvases that need rendering
                        setTimeout(() => {
                            const pdfCanvases = document.querySelectorAll('canvas[data-pdf-src]');
                            pdfCanvases.forEach(canvas => {
                                const uri = canvas.getAttribute('data-pdf-src');
                                const id = canvas.id;
                                const renderedUri = canvas.getAttribute('data-rendered-uri');

                                // Only render if URI changed or never rendered
                                if (uri && id && renderedUri !== uri) {
                                    window.renderPdfToCanvas(uri, id);
                                }
                            });
                        }, 50);
                    }
                });

                // Signal readiness again for module script
                vscode.postMessage({ command: 'webviewLoaded' });
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