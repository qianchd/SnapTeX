import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { SmartRenderer } from './renderer';
import { TexPreviewPanel } from './panel';

// 全局唯一的渲染引擎实例
const renderer = new SmartRenderer();

/**
 * 智能获取当前项目根目录
 * 确保能准确找到用户 .tex 文件所在文件夹下的 config.js
 */
function getProjectRoot(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        // 1. 优先尝试获取当前文件所属的 VS Code 工作区文件夹
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (workspaceFolder) {
            return workspaceFolder.uri.fsPath;
        }
        // 2. 如果文件不在工作区内（单独打开），则取文件所在的目录
        return path.dirname(editor.document.uri.fsPath);
    }
    // 3. 最后退而求其次取第一个打开的文件夹
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * 插件激活入口
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('[TeX Fast Preview] Extension is now active.');

    const globalConfigPath = path.join(os.homedir(), '.tex-preview.global.js');
    const root = getProjectRoot();

    // 1. 初始加载所有规则层级 (默认 + 全局 + 工作区)
    renderer.reloadAllRules(root);

    // 2. 注册启动命令
    context.subscriptions.push(
        vscode.commands.registerCommand('texPreview.start', () => {
            // 确保传入渲染器单例
            TexPreviewPanel.createOrShow(context.extensionPath, renderer);
        })
    );

    // 3. 监听全局配置文件变动 (~/.tex-preview.global.js)
    const globalWatcher = vscode.workspace.createFileSystemWatcher(globalConfigPath);
    globalWatcher.onDidChange(() => {
        console.log('[TeX Preview] 检测到全局配置变动，正在重载...');
        renderer.reloadAllRules(getProjectRoot());
        TexPreviewPanel.currentPanel?.update();
    });
    context.subscriptions.push(globalWatcher);

    // 4. 监听工作区配置文件变动 (项目根目录/tex-preview.config.js)
    if (root) {
        const workspaceWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(root, 'tex-preview.config.js')
        );
        workspaceWatcher.onDidChange(() => {
            console.log('[TeX Preview] 检测到工作区配置变动，正在重载...');
            renderer.reloadAllRules(root);
            TexPreviewPanel.currentPanel?.update();
        });
        context.subscriptions.push(workspaceWatcher);
    }

    // 5. 监听文档修改事件 (增加防抖阈值)
    let debounceTimer: NodeJS.Timeout | undefined;
    // 我们将渲染防抖稍微拉长到 150ms，以腾出更多 CPU 给 Webview 的布局计算
    const RENDER_DEBOUNCE = 100;
    vscode.workspace.onDidChangeTextDocument(e => {
        if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
            if (debounceTimer) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(() => {
                // 仅当 Webview 可见时才推送更新，节省后台开销
                if (TexPreviewPanel.currentPanel) {
                    TexPreviewPanel.currentPanel.update();
                }
            }, RENDER_DEBOUNCE);
        }
    }, null, context.subscriptions);

    // 6. 监听切换编辑器事件：实现“点哪看哪”并自动切换对应项目的规则
    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            const newRoot = getProjectRoot();
            renderer.reloadAllRules(newRoot);
            TexPreviewPanel.currentPanel?.update();
        }
    }, null, context.subscriptions);
}

export function deactivate() {
    console.log('[TeX Fast Preview] Extension deactivated.');
}