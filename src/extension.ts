import * as vscode from 'vscode';
import * as path from 'path';
import MarkdownIt = require('markdown-it');
const mdKatex = require('@iktakahiro/markdown-it-katex');

// --- 宏解析器 (保持不变) ---
function parseLatexMacros(preamble: string): Record<string, string> {
    const macros: Record<string, string> = {};
    const cleanText = preamble.replace(/(?<!\\)%.*/gm, '');
    const cmdHeadRegex = /\\(newcommand|renewcommand|def|gdef|DeclareMathOperator)(\*?)\s*\{?(\\[a-zA-Z0-9]+)\}?(?:\[(\d+)\])?/g;
    let match;
    while ((match = cmdHeadRegex.exec(cleanText)) !== null) {
        const cmdType = match[1];
        const star = match[2];
        const cmdName = match[3];
        const matchEndIndex = match.index + match[0].length;
        let openBraces = 0;
        let contentStartIndex = -1;
        let contentEndIndex = -1;
        let foundStart = false;
        for (let i = matchEndIndex; i < cleanText.length; i++) {
            const char = cleanText[i];
            if (char === '{') {
                if (!foundStart) { contentStartIndex = i + 1; foundStart = true; }
                openBraces++;
            } else if (char === '}') {
                openBraces--;
                if (foundStart && openBraces === 0) { contentEndIndex = i; break; }
            }
        }
        if (contentStartIndex !== -1 && contentEndIndex !== -1) {
            const definition = cleanText.substring(contentStartIndex, contentEndIndex).trim();
            if (cmdType === 'DeclareMathOperator') {
                if (star === '*') macros[cmdName] = `\\operatorname*{${definition}}`;
                else macros[cmdName] = `\\operatorname{${definition}}`;
            } else {
                macros[cmdName] = definition;
            }
        }
    }
    return macros;
}

// --- 分块器 (保持不变) ---
class LatexBlockSplitter {
    public static split(text: string): string[] {
        const blocks: string[] = [];
        let currentBuffer = "";
        let stackDepth = 0;
        const regex = /(?<!\\)%.*|\\begin\{([^}]+)\}|\\end\{([^}]+)\}|(\n{2,})/g;
        let lastIndex = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const preMatchText = text.substring(lastIndex, match.index);
            currentBuffer += preMatchText;
            lastIndex = regex.lastIndex;
            const fullMatch = match[0];
            const isComment = fullMatch.startsWith('%');
            const beginEnv = match[1];
            const endEnv = match[2];
            const isDoubleNewline = match[3];
            if (isComment) { currentBuffer += fullMatch; continue; }
            if (beginEnv) {
                if (beginEnv === 'document') { currentBuffer += fullMatch; }
                else {
                    if (stackDepth === 0) {
                        if (currentBuffer.trim().length > 0) { blocks.push(currentBuffer); currentBuffer = ""; }
                    }
                    stackDepth++; currentBuffer += fullMatch;
                }
            } else if (endEnv) {
                if (endEnv === 'document') { currentBuffer += fullMatch; }
                else {
                    stackDepth--; currentBuffer += fullMatch;
                    if (stackDepth === 0) { blocks.push(currentBuffer); currentBuffer = ""; }
                    if (stackDepth < 0) stackDepth = 0;
                }
            } else if (isDoubleNewline) {
                if (stackDepth === 0) {
                    if (currentBuffer.trim().length > 0) { blocks.push(currentBuffer); currentBuffer = ""; }
                } else { currentBuffer += fullMatch; }
            }
        }
        currentBuffer += text.substring(lastIndex);
        if (currentBuffer.trim().length > 0) { blocks.push(currentBuffer); }
        return blocks;
    }
}

// 定义 Patch 数据结构
interface PatchPayload {
    type: 'full' | 'patch';
    html?: string; // full 模式用
    start?: number; // patch 模式用
    deleteCount?: number; // patch 模式用
    htmls?: string[]; // patch 模式用
}

class SmartRenderer {
    private lastBlocks: { text: string, html: string }[] = [];
    private lastPreambleHash: string = "";
    private md: MarkdownIt | null = null;

    constructor() { this.rebuildMarkdownEngine({}); }

    private rebuildMarkdownEngine(macros: Record<string, string>) {
        this.md = new MarkdownIt({ html: true, linkify: true, typographer: true });
        this.md.disable('code');
        this.md.use(mdKatex, { macros, globalGroup: true, throwOnError: false, errorColor: '#cc0000' });
    }

    private extractAndHideLabels(content: string): { cleanContent: string, hiddenHtml: string } {
        const labels: string[] = [];
        const cleanContent = content.replace(/\\label\{([^}]+)\}/g, (match, labelName) => {
            const safeLabel = labelName.replace(/"/g, '&quot;');
            labels.push(`<span id="${safeLabel}" class="latex-label-anchor" data-label="${safeLabel}" style="display:none"></span>`);
            return '';
        });
        return { cleanContent: cleanContent, hiddenHtml: labels.join('') };
    }

    private preprocessLatexMath(text: string): string {
        const getPrefix = (offset: number, fullStr: string) => {
            return (offset > 0 && fullStr[offset - 1] !== '\n') ? '\n' : '';
        };
        const getSuffix = (hiddenHtml: string) => {
            return hiddenHtml ? `\n${hiddenHtml}` : '';
        };

        text = text.replace(/\\\[([\s\S]*?)\\\]/gm, (match, content, offset, fullStr) => {
            const prefix = getPrefix(offset, fullStr);
            const { cleanContent, hiddenHtml } = this.extractAndHideLabels(content);
            return `${prefix}$$\n${cleanContent.trim()}\n$$${getSuffix(hiddenHtml)}`;
        });
        text = text.replace(/\\begin\{equation(\*?)\}([\s\S]*?)\\end\{equation\1\}/gm, (match, star, content, offset, fullStr) => {
            const prefix = getPrefix(offset, fullStr);
            const { cleanContent, hiddenHtml } = this.extractAndHideLabels(content);
            return `${prefix}$$\n${cleanContent.trim()}\n$$${getSuffix(hiddenHtml)}`;
        });
        text = text.replace(/\\begin\{align(\*?)\}([\s\S]*?)\\end\{align\1\}/gm, (match, star, content, offset, fullStr) => {
            const prefix = getPrefix(offset, fullStr);
            const { cleanContent, hiddenHtml } = this.extractAndHideLabels(content);
            return `${prefix}$$\n\\begin{aligned}\n${cleanContent.trim()}\n\\end{aligned}\n$$${getSuffix(hiddenHtml)}`;
        });
        text = text.replace(/\\begin\{gather(\*?)\}([\s\S]*?)\\end\{gather\1\}/gm, (match, star, content, offset, fullStr) => {
            const prefix = getPrefix(offset, fullStr);
            const { cleanContent, hiddenHtml } = this.extractAndHideLabels(content);
            return `${prefix}$$\n\\begin{gathered}\n${cleanContent.trim()}\n\\end{gathered}\n$$${getSuffix(hiddenHtml)}`;
        });
        const otherEnvs = ['multline', 'flalign', 'alignat'].join('|');
        const regex = new RegExp(`(\\\\begin\\{(${otherEnvs})(\\*?)\\}[\\s\\S]*?\\\\end\\{\\2\\3\\})`, 'gm');
        text = text.replace(regex, (match, p1, p2, p3, offset, fullStr) => {
            const prefix = getPrefix(offset, fullStr);
            const { cleanContent, hiddenHtml } = this.extractAndHideLabels(match);
            return `${prefix}$$\n${cleanContent}\n$$${getSuffix(hiddenHtml)}`;
        });
        text = text.replace(/\\label\{([^}]+)\}/g, (match, labelName) => {
             const safeLabel = labelName.replace(/"/g, '&quot;');
             return `<span id="${safeLabel}" class="latex-label-anchor" data-label="${safeLabel}" style="display:none"></span>`;
        });
        return text;
    }

    /**
     * 计算增量更新 Patch
     */
    public render(fullText: string): PatchPayload {
        const cleanText = fullText.replace(/(?<!\\)%.*/gm, '');
        const docStartRegex = /\\begin\{document\}/;
        const match = cleanText.match(docStartRegex);

        let bodyText = cleanText;
        let currentPreamble = "";

        if (match && match.index !== undefined) {
            currentPreamble = cleanText.substring(0, match.index);
            bodyText = cleanText.substring(match.index + match[0].length);
            bodyText = bodyText.replace(/\\end\{document\}/, '');
        }

        if (currentPreamble !== this.lastPreambleHash) {
            const extractedMacros = parseLatexMacros(currentPreamble);
            this.rebuildMarkdownEngine(extractedMacros);
            this.lastBlocks = []; // Preamble 变了，必须强制全量刷新
            this.lastPreambleHash = currentPreamble;
        }

        let rawBlocks = LatexBlockSplitter.split(bodyText);

        if (!this.md) this.rebuildMarkdownEngine({});

        const oldBlocks = this.lastBlocks;

        // 生成新块数据
        const newBlocksData = rawBlocks.map(blockText => {
            const trimmedText = blockText.trim();
            const processedText = this.preprocessLatexMath(trimmedText);
            // 为了让 Webview 更好地处理，我们给每个 Block 包裹一个 div
            // 这样我们在 Webview 端就可以按 div 进行 splice
            const innerHtml = this.md!.render(processedText);
            const html = `<div class="latex-block">${innerHtml}</div>`;
            return {
                text: trimmedText,
                html: html
            };
        });

        // ---------------- Diff 核心逻辑 ----------------

        // 1. 如果是从零开始，或者 Preamble 变了，发送全量
        if (oldBlocks.length === 0) {
            this.lastBlocks = newBlocksData;
            return {
                type: 'full',
                html: newBlocksData.map(b => b.html).join('')
            };
        }

        let startMatchIndex = 0;
        const minLen = Math.min(newBlocksData.length, oldBlocks.length);
        while (startMatchIndex < minLen) {
            if (newBlocksData[startMatchIndex].text !== oldBlocks[startMatchIndex].text) break;
            startMatchIndex++;
        }

        let endMatchCount = 0;
        const oldRemaining = oldBlocks.length - startMatchIndex;
        const newRemaining = newBlocksData.length - startMatchIndex;
        while (endMatchCount < Math.min(oldRemaining, newRemaining)) {
            const oldIndex = oldBlocks.length - 1 - endMatchCount;
            const newIndex = newBlocksData.length - 1 - endMatchCount;
            if (oldBlocks[oldIndex].text !== newBlocksData[newIndex].text) break;
            endMatchCount++;
        }

        // 2. 如果没有任何变化
        if (startMatchIndex === oldBlocks.length && startMatchIndex === newBlocksData.length) {
             // 理论上不需要更新，但为了安全可以返回空 patch (这里简化处理，直接不返回或返回空操作，前端兼容即可)
             // 我们这里假设如果有变化才调用 render，或者前端处理空 patch
        }

        // 3. 计算 Patch 参数 (Splice Logic)
        // 我们需要把 oldBlocks 中间不同的部分替换为 newBlocks 中间不同的部分
        const deleteCount = oldBlocks.length - startMatchIndex - endMatchCount;
        const insertBlocks = newBlocksData.slice(startMatchIndex, newBlocksData.length - endMatchCount);
        const insertHtmls = insertBlocks.map(b => b.html);

        // 更新缓存
        const finalBlocks: { text: string, html: string }[] = [];
        for (let i = 0; i < startMatchIndex; i++) finalBlocks.push(oldBlocks[i]);
        for (let i = 0; i < insertBlocks.length; i++) finalBlocks.push(insertBlocks[i]);
        for (let i = 0; i < endMatchCount; i++) finalBlocks.push(oldBlocks[oldBlocks.length - endMatchCount + i]);
        this.lastBlocks = finalBlocks;

        return {
            type: 'patch',
            start: startMatchIndex,
            deleteCount: deleteCount,
            htmls: insertHtmls
        };
    }
}

const renderer = new SmartRenderer();

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('texPreview.start', () => {
            TexPreviewPanel.createOrShow(context.extensionPath);
        })
    );
    let debounceTimer: NodeJS.Timeout | undefined;
    const DEBOUNCE_DELAY = 100; // 局部更新性能很好，可以缩短防抖时间
    vscode.workspace.onDidChangeTextDocument(e => {
        if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                TexPreviewPanel.currentPanel?.update();
            }, DEBOUNCE_DELAY);
        }
    }, null, context.subscriptions);

    vscode.window.onDidChangeActiveTextEditor(e => {
        TexPreviewPanel.currentPanel?.update();
    }, null, context.subscriptions);
}

class TexPreviewPanel {
    public static currentPanel: TexPreviewPanel | undefined;
    public static readonly viewType = 'texPreview';
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionPath: string;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionPath: string) {
        const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
        if (TexPreviewPanel.currentPanel) {
            TexPreviewPanel.currentPanel._panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            TexPreviewPanel.viewType, 'TeX Preview', column,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.file(extensionPath),
                    vscode.Uri.file(path.join(extensionPath, 'node_modules'))
                ]
            }
        );
        TexPreviewPanel.currentPanel = new TexPreviewPanel(panel, extensionPath);
    }

    private constructor(panel: vscode.WebviewPanel, extensionPath: string) {
        this._panel = panel;
        this._extensionPath = extensionPath;
        this._panel.webview.html = this._getWebviewSkeleton();
        this.update();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose() {
        TexPreviewPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }

    public update() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const text = editor.document.getText();

        // 获取 Patch Payload
        const payload = renderer.render(text);

        // 发送给 Webview
        this._panel.webview.postMessage({
            command: 'update',
            payload: payload
        });
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
        let distDir = "";
        if (katexMainPath.includes('dist')) {
            distDir = path.dirname(katexMainPath);
        } else {
             distDir = path.join(path.dirname(katexMainPath), 'dist');
        }
        return {
            cssFile: vscode.Uri.file(path.join(distDir, 'katex.min.css')),
            distDirUri: this._panel.webview.asWebviewUri(vscode.Uri.file(distDir))
        };
    }

    private _getWebviewSkeleton() {
        const paths = this.getKatexPaths();
        const katexCssUri = this._panel.webview.asWebviewUri(paths.cssFile);
        const baseUri = paths.distDirUri + '/';

        // 【新增】获取 preview_style.css 的 URI
        const stylePath = vscode.Uri.file(path.join(this._extensionPath, 'src/preview-style.css'));
        const styleUri = this._panel.webview.asWebviewUri(stylePath);

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <base href="${baseUri}">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this._panel.webview.cspSource} 'unsafe-inline'; font-src ${this._panel.webview.cspSource} data:; script-src ${this._panel.webview.cspSource} 'unsafe-inline' https://unpkg.com;">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>TeX Preview</title>

                <link rel="stylesheet" href="${katexCssUri}">
                <link rel="stylesheet" href="${styleUri}">
            </head>
            <body>
                <div id="content-root"></div>
                <script>
                    const contentRoot = document.getElementById('content-root');

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.command === 'update') {
                            const payload = message.payload;

                            if (payload.type === 'full') {
                                // 全量更新
                                contentRoot.innerHTML = payload.html;
                            } else if (payload.type === 'patch') {
                                // 局部增量更新 (Splice DOM)
                                const start = payload.start;
                                const deleteCount = payload.deleteCount;
                                const newHtmls = payload.htmls || [];

                                // 1. 获取当前所有的 block 元素
                                const children = Array.from(contentRoot.children);

                                // 2. 删除需要移除的节点
                                for (let i = 0; i < deleteCount; i++) {
                                    if (children[start + i]) {
                                        contentRoot.removeChild(children[start + i]);
                                    }
                                }

                                // 3. 插入新节点
                                // 找到插入点（参考节点）
                                // 如果删除了元素，后续元素索引会前移，所以参考节点就是原来 start + deleteCount 位置的节点
                                // 但因为删除了，现在的 children[start] 其实就是原来的 children[start + deleteCount] (如果存在)
                                // 所以我们重新获取一下当前状态下的参考节点
                                const currentChildren = contentRoot.children;
                                const referenceNode = currentChildren[start] || null;

                                // 创建一个临时容器来把 HTML 字符串转为 DOM 节点
                                const tempDiv = document.createElement('div');

                                newHtmls.forEach(html => {
                                    tempDiv.innerHTML = html;
                                    const newBlock = tempDiv.firstElementChild; // 获取 .latex-block
                                    if (newBlock) {
                                        contentRoot.insertBefore(newBlock, referenceNode);
                                    }
                                });
                            }
                        }
                    });
                </script>
            </body>
            </html>`;
    }
}
export function deactivate() {}