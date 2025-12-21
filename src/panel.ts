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

        // 【对照修复】初始化时重置状态
        this._renderer.resetState();

        this._panel.webview.html = this._getWebviewSkeleton();

        // 确保首次加载
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

    // 【从 ext-old 移植】精准查找 KaTeX 本地路径
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

                    // --- 方案 C: 纯防抖字号更新系统 (无 Transform) ---
                    (function() {
                        try {
                            const root = document.documentElement;
                            // 获取 CSS 中定义的原始 vw/vh 字符串
                            const computedStyle = getComputedStyle(root);
                            const rawValue = computedStyle.getPropertyValue('--base-font-size').trim();

                            if (!rawValue) return;

                            const match = rawValue.match(/^([\\d.]+)(vw|vh)$/);
                            if (match) {
                                const value = parseFloat(match[1]);
                                const unit = match[2];
                                const ratio = value / 100;
                                let resizeTimer;

                                /**
                                 * 执行物理像素更新
                                 * 只有在停止拉动后触发，产生一次全量重排
                                 */
                                function updateFixedSize() {
                                    const viewportSize = unit === 'vw' ? window.innerWidth : window.innerHeight;
                                    let newPx = viewportSize * ratio;

                                    // 最小/最大字号限制，防止极端情况
                                    if (newPx < 12) newPx = 12;
                                    if (newPx > 40) newPx = 40;

                                    // 直接更新 CSS 变量
                                    root.style.setProperty('--base-font-size', newPx + 'px');
                                    console.log('[Preview] Font resized to:', newPx.toFixed(1) + 'px');
                                }

                                // 初始执行一次
                                updateFixedSize();

                                // 监听窗口调整
                                window.addEventListener('resize', () => {
                                    // 拉动过程中不进行任何计算，直接清除计时器
                                    if (resizeTimer) clearTimeout(resizeTimer);

                                    // 停止拉动 150ms 后执行一次
                                    resizeTimer = setTimeout(updateFixedSize, 150);
                                });
                            }
                        } catch (e) {
                            console.error('Resize error:', e);
                        }
                    })();

                    // --- 消息监听：处理内容更新 ---
                    window.addEventListener('message', event => {
                        const { command, payload } = event.data;
                        if (command === 'update') {
                            if (payload.type === 'full') {
                                // 1. 【加锁】开启预加载模式
                                document.body.classList.add('preload-mode');

                                // 2. 写入 HTML
                                contentRoot.innerHTML = payload.html;

                                // 3. 【关键修复】等待字体加载完毕后再解锁
                                document.fonts.ready.then(() => {
                                    // 等待两帧，确保 DOM 结构和样式已应用
                                    requestAnimationFrame(() => {
                                        requestAnimationFrame(() => {
                                            // 4. 【强制回流】读取一次 scrollHeight
                                            // 这行代码看似无用，但它会强迫浏览器完成一次布局计算，
                                            // 确保它在切换回 auto 之前，已经"看到"了真实的元素高度。
                                            const _forceLayout = document.body.scrollHeight;

                                            // 5. 【解锁】恢复 content-visibility: auto
                                            document.body.classList.remove('preload-mode');

                                            console.log('[Preview] Initial render done. Height locked at:', _forceLayout);
                                        });
                                    });
                                });
                            } else if (payload.type === 'patch') {
                                const { start, deleteCount, htmls = [] } = payload;
                                const targetIndex = start + deleteCount;
                                const referenceNode = contentRoot.children[targetIndex] || null;

                                for (let i = 0; i < deleteCount; i++) {
                                    if (contentRoot.children[start]) contentRoot.removeChild(contentRoot.children[start]);
                                }

                                const fragment = document.createDocumentFragment();
                                htmls.forEach(html => {
                                    const tempDiv = document.createElement('div');
                                    tempDiv.innerHTML = html;
                                    const node = tempDiv.firstElementChild;
                                    if (node) fragment.appendChild(node);
                                });
                                contentRoot.insertBefore(fragment, referenceNode);
                            }
                        }
                    });

                    // --- 跳转监听 ---
                    document.addEventListener('click', e => {
                        const target = e.target.closest('a');
                        if (target && target.getAttribute('href')?.startsWith('#')) {
                            const id = target.getAttribute('href').substring(1);
                            const element = document.getElementById(id);
                            if (element) {
                                e.preventDefault();
                                const scrollTarget = element.closest('.latex-block') || element;
                                scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                const parentBlock = element.closest('.latex-block');
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