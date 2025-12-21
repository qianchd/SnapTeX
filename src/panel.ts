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
                const contentRoot = document.getElementById('content-root');
                const root = document.documentElement;

                // 状态标志：是否启用了动态缩放模式
                let isDynamicMode = false;
                // 缓存原始的比例系数 (例如 2.2)
                let dynamicRatio = 0.022;
                let dynamicUnit = 'vw';

                // --- 1. 初始化检测 (智能判断) ---
                (function initFontSizeStrategy() {
                    // 获取 CSS 中定义的原始值
                    // 必须去掉空白，因为有时候写成 " 16px "
                    const rawValue = getComputedStyle(root).getPropertyValue('--base-font-size').trim();

                    if (!rawValue) return; // 没定义变量，直接退出

                    // 正则匹配：数字 + 单位
                    const match = rawValue.match(/^([\d\.]+)(vw|vh)$/);

                    if (match) {
                        // Case A: 用户写了 vw/vh，说明想要动态缩放
                        // 启用 JS 接管模式
                        isDynamicMode = true;
                        dynamicRatio = parseFloat(match[1]) / 100; // 例如 2.2 -> 0.022
                        dynamicUnit = match[2];
                        // 立即执行一次同步，把 vw 转换为固定的 px (防止初始渲染抖动)
                        syncFontSize();
                    } else {
                        // Case B: 用户写了 px/em/rem，说明想要固定大小
                        // 禁用 JS 接管，直接用 CSS 原生行为
                        isDynamicMode = false;
                    }
                })();

                // --- 2. 核心字号计算逻辑 (仅在动态模式下工作) ---
                function syncFontSize() {
                    if (!isDynamicMode) return false;

                    const viewportSize = dynamicUnit === 'vw' ? window.innerWidth : window.innerHeight;
                    let targetPx = viewportSize * dynamicRatio;

                    // 限制范围 (根据需要调整)
                    if (targetPx < 12) targetPx = 12;
                    if (targetPx > 40) targetPx = 40;

                    const val = targetPx.toFixed(1) + 'px';

                    // 只有数值变了才写入，减少重排
                    if (root.style.getPropertyValue('--base-font-size') !== val) {
                        root.style.setProperty('--base-font-size', val);
                        return true;
                    }
                    return false;
                }

                // --- 3. 监听窗口调整 ---
                let resizeTimer;
                window.addEventListener('resize', () => {
                    if (!isDynamicMode) return; // 静态模式下忽略 resize

                    if (resizeTimer) clearTimeout(resizeTimer);
                    // 防抖：拖拽时 CSS 变量被锁死在上次的 px 值，停止后才更新
                    resizeTimer = setTimeout(() => {
                        syncFontSize();
                    }, 200);
                });

                // --- 4. 消息处理 ---
                window.addEventListener('message', event => {
                    const { command, payload } = event.data;
                    if (command === 'update') {
                        if (payload.type === 'full') {
                            console.log("full update");

                            // [Step A] 加锁
                            document.body.classList.add('preload-mode');

                            // [Step B] 强制同步字号
                            // 如果是动态模式，这一步会保证字号是最新的 px
                            // 如果是静态模式，这一步直接返回，啥也不做
                            syncFontSize();

                            // [Step C] 写入内容
                            contentRoot.innerHTML = payload.html;

                            const _height0 = document.body.scrollHeight;

                            // [Step D] 等待字体 + 强制回流
                            document.fonts.ready.then(() => {
                                requestAnimationFrame(() => {
                                    requestAnimationFrame(() => {
                                        // 强制浏览器计算真实高度 (Layout Thrashing)
                                        // 这一步对于 content-visibility: auto 的记忆至关重要
                                        const _height = document.body.scrollHeight;

                                        // [Step F] 解锁
                                        document.body.classList.remove('preload-mode');

                                        console.log('[Preview] Full render done. Height:', _height, ':0:', _height0);
                                    });
                                });
                            });
                        } else if (payload.type === 'patch') {
                            console.log("local update");
                            // Patch 逻辑... (保持不变)
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

                // 跳转监听 (保持不变)
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