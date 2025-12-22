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

        // 收集允许访问的路径
        const localResourceRoots = [
            vscode.Uri.file(extensionPath),
            vscode.Uri.file(path.join(extensionPath, 'node_modules')),
            vscode.Uri.file(path.join(extensionPath, 'media')) // 确保 media 目录被包含
        ];

        // 关键修复：允许访问当前打开的所有工作区文件夹（确保用户图片和PDF能加载）
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
        // 如果已经有面板，先销毁旧的（单例模式）
        if (TexPreviewPanel.currentPanel) {
            TexPreviewPanel.currentPanel.dispose();
        }

        // 配置恢复后的面板属性（因为 VS Code 恢复的面板可能丢失了部分配置）
        // 重新注入 localResourceRoots 是必须的，否则图片/CSS 会挂
        const localResourceRoots = [
            vscode.Uri.file(extensionPath),
            vscode.Uri.file(path.join(extensionPath, 'node_modules')),
            vscode.Uri.file(path.join(extensionPath, 'media'))
        ];
        if (vscode.workspace.workspaceFolders) {
            vscode.workspace.workspaceFolders.forEach(folder => {
                localResourceRoots.push(folder.uri);
            });
        }

        // 关键：重新设置 options，确保 retainContextWhenHidden 生效
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: localResourceRoots
        };

        // 创建新实例接管这个 panel
        TexPreviewPanel.currentPanel = new TexPreviewPanel(panel, extensionPath, renderer);
    }

    private constructor(panel: vscode.WebviewPanel, extensionPath: string, renderer: SmartRenderer) {
        this._panel = panel;
        this._extensionPath = extensionPath;
        this._renderer = renderer;

        this._renderer.resetState();
        this._panel.webview.html = this._getWebviewSkeleton();

        // Send Reload message
        this._panel.webview.onDidReceiveMessage(
            message => {
                if (message.command === 'webviewLoaded') {
                    console.log('[SnapTeX] Webview reloaded (DOM reset detected. Forcing full re-render.');
                    this._renderer.resetState();
                    this.update();
                }
            },
            null,
            this._disposables
        );

        this.update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public postMessage(message: any) {
        this._panel.webview.postMessage(message);
    }

    public update() {
        const editor = vscode.window.activeTextEditor;

        // [Fix] 核心修复：不要完全依赖 activeTextEditor
        // 当 Webview 被分屏、拖拽重启时，焦点在 Webview 上，此时 activeTextEditor 为 undefined。
        // 我们需要回退到上一次记录的 _sourceUri 来寻找文档。
        let doc = editor ? editor.document : undefined;

        if (!doc && this._sourceUri) {
            // 尝试在已打开的文档中查找
            doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === this._sourceUri!.toString());
        }

        // 如果连历史文档都找不到（比如文件被关闭了），那就真的没法渲染了
        if (!doc) {
            console.warn('[SnapTeX] Cannot find source document for update.');
            return;
        }

        // 更新当前渲染源
        this._sourceUri = doc.uri;
        const docDir = path.dirname(this._sourceUri.fsPath);

        const text = doc.getText(); // 使用找到的 doc 获取文本，而不是 editor.document
        let payload = this._renderer.render(text);

        // 修改：同时处理 img src 和 canvas data-pdf-src 的路径转换
        const fixPaths = (html: string) => {
            return html
                // 转换普通图片
                .replace(/src="LOCAL_IMG:([^"]+)"/g, (match, relPath) => {
                    const fullPath = path.isAbsolute(relPath) ? relPath : path.join(docDir, relPath);
                    const uri = this._panel.webview.asWebviewUri(vscode.Uri.file(fullPath));
                    return `src="${uri}"`;
                })
                // 转换 PDF 路径
                .replace(/data-pdf-src="LOCAL_IMG:([^"]+)"/g, (match, relPath) => {
                    const fullPath = path.isAbsolute(relPath) ? relPath : path.join(docDir, relPath);
                    const uri = this._panel.webview.asWebviewUri(vscode.Uri.file(fullPath));
                    return `data-pdf-src="${uri}"`;
                });
        };

        if (payload.type === 'full' && payload.html) {
            payload.html = fixPaths(payload.html);
        } else if (payload.type === 'patch' && payload.htmls) {
            payload.htmls = payload.htmls.map(h => fixPaths(h));
        }

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

        const pdfJsPath = vscode.Uri.file(path.join(this._extensionPath, 'media', 'vendor', 'pdfjs', 'pdf.mjs'));
        const pdfJsUri = this._panel.webview.asWebviewUri(pdfJsPath);

        const pdfWorkerPath = vscode.Uri.file(path.join(this._extensionPath, 'media', 'vendor', 'pdfjs', 'pdf.worker.mjs'));
        const pdfWorkerUri = this._panel.webview.asWebviewUri(pdfWorkerPath);

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <base href="${baseUri}">
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
                            // 旧的多，删除
                            if (oldEl) oldEl.remove();
                            continue;
                        }
                        if (!oldEl) {
                            // 新的多，追加
                            contentRoot.appendChild(newEl);
                            continue;
                        }

                        // 核心：比较 outerHTML (内容+属性)
                        // 如果完全一致，则直接跳过，保留旧 DOM（这样 Canvas 状态和图片加载状态就不会丢）
                        if (oldEl.outerHTML !== newEl.outerHTML) {
                            oldEl.replaceWith(newEl);
                        }
                    }
                }

                window.addEventListener('message', event => {
                    const { command, payload, index, ratio, anchor } = event.data;

                    if (command === 'update') {
                        if (payload.type === 'full') {
                            // 1. Capture scroll state before nuking DOM
                            const scrollState = saveScrollState();

                            document.body.classList.add('preload-mode');
                            smartFullUpdate(payload.html);

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
                vscode.postMessage({ command: 'webviewLoaded' }); // Send message to extension
            </script>
            <script type="module">
                import * as pdfjsLib from '${pdfJsUri}';
                pdfjsLib.GlobalWorkerOptions.workerSrc = '${pdfWorkerUri}';

                window.renderPdfToCanvas = async (pdfUri, canvasId) => {
                    try {
                        const canvas = document.getElementById(canvasId);
                        if (!canvas) return;

                        // [Fix 2] 防止重复渲染：检查是否正在渲染或已经渲染
                        if (canvas.getAttribute('data-rendering') === 'true') return;

                        canvas.setAttribute('data-rendering', 'true'); // 标记正在渲染

                        const loadingTask = pdfjsLib.getDocument(pdfUri);
                        const pdf = await loadingTask.promise;
                        const page = await pdf.getPage(1);

                        // 简单的宽高计算，避免重置 canvas 导致闪烁
                        const scale = 3;
                        const viewport = page.getViewport({ scale: scale });

                        // 只有当尺寸变化时才清空 canvas
                        if (canvas.width !== viewport.width || canvas.height !== viewport.height) {
                            canvas.height = viewport.height;
                            canvas.width = viewport.width;
                        }

                        const context = canvas.getContext('2d');
                        await page.render({ canvasContext: context, viewport: viewport }).promise;

                        canvas.removeAttribute('data-rendering');
                        // [Fix 3] 标记已渲染的 URI，防止 update 循环重复调用
                        canvas.setAttribute('data-rendered-uri', pdfUri);

                    } catch (error) {
                        console.error('PDF render error:', error);
                        const c = document.getElementById(canvasId);
                        if(c) c.removeAttribute('data-rendering');
                    }
                };

                window.addEventListener('message', event => {
                    if (event.data.command === 'update') {
                        setTimeout(() => {
                            const pdfCanvases = document.querySelectorAll('canvas[data-pdf-src]');
                            pdfCanvases.forEach(canvas => {
                                const uri = canvas.getAttribute('data-pdf-src');
                                const id = canvas.id;
                                const renderedUri = canvas.getAttribute('data-rendered-uri');

                                // [Fix 4] 仅当 URI 发生变化，或者从未渲染过时，才触发渲染
                                // 如果 URI 没变，说明是其他文本更新触发的 update，直接忽略，防止闪烁
                                if (uri && id && renderedUri !== uri) {
                                    window.renderPdfToCanvas(uri, id);
                                }
                            });
                        }, 50); // 稍微缩短延时
                    }
                });
                vscode.postMessage({ command: 'webviewLoaded' }); // Send message to extension
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