import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { SmartRenderer } from './renderer';
import { TexPreviewPanel } from './panel';

// Global unique rendering engine instance
const renderer = new SmartRenderer();

/**
 * Smartly get the current project root directory
 * Ensure accurate finding of config.js in the folder where the user's .tex file is located
 */
function getProjectRoot(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        // 1. Prioritize trying to get the VS Code workspace folder to which the current file belongs
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (workspaceFolder) {
            return workspaceFolder.uri.fsPath;
        }
        // 2. If the file is not in the workspace (opened individually), take the directory where the file is located
        return path.dirname(editor.document.uri.fsPath);
    }
    // 3. Finally, settle for the first opened folder
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Extension activation entry
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('[SnapTeX] Extension is now active.');

    const globalConfigPath = path.join(os.homedir(), '.snaptex.global.js');

    // [Optimized] Define a variable to record the currently loaded Rule Root
    let currentRoot = getProjectRoot();

    // 1. Initial load of all rule levels (Default + Global + Workspace)
    renderer.reloadAllRules(currentRoot);

    // 2. Register startup command
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.start', () => {
            // Ensure passing the renderer singleton
            const panel = TexPreviewPanel.createOrShow(context.extensionPath, renderer);
            setupReverseSync(panel);
        })
    );

    // [New] Register Forward Sync Command (Editor -> Preview)
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.syncToPreview', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !TexPreviewPanel.currentPanel) { return; }

            // 1. Get current line
            const line = editor.selection.active.line;
            // 2. Calculate corresponding block index
            const blockIndex = renderer.getBlockIndexByLine(line);

            console.log(`[SnapTeX] Sync to preview: Line ${line} -> Block ${blockIndex}`);

            // 3. Send message to Webview
            TexPreviewPanel.currentPanel.postMessage({
                command: 'scrollToBlock',
                index: blockIndex
            });
        })
    );

    // 3. Watch global configuration file changes (~/.snaptex.global.js)
    const globalWatcher = vscode.workspace.createFileSystemWatcher(globalConfigPath);
    globalWatcher.onDidChange(() => {
        console.log('[TeX Preview] Global config change detected, reloading...');
        renderer.reloadAllRules(getProjectRoot());
        TexPreviewPanel.currentPanel?.update();
    });
    context.subscriptions.push(globalWatcher);

    // 4. Watch workspace configuration file changes (Project Root/snaptex.config.js)
    if (currentRoot) {
        const workspaceWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(currentRoot, 'snaptex.config.js')
        );
        workspaceWatcher.onDidChange(() => {
            console.log('[TeX Preview] Workspace config change detected, reloading...');
            renderer.reloadAllRules(currentRoot);
            TexPreviewPanel.currentPanel?.update();
        });
        context.subscriptions.push(workspaceWatcher);
    }

    // 5. Watch document modification events (Increase debounce threshold)
    let debounceTimer: NodeJS.Timeout | undefined;
    const RENDER_DEBOUNCE = 100;
    vscode.workspace.onDidChangeTextDocument(e => {
        if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
            if (debounceTimer) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(() => {
                // Push updates only when Webview is visible to save background overhead
                if (TexPreviewPanel.currentPanel) {
                    TexPreviewPanel.currentPanel.update();
                }
            }, RENDER_DEBOUNCE);
        }
    }, null, context.subscriptions);

    // 6. Watch switch editor events: Implement "See where you click" and automatically switch rules for the corresponding project
    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            const newRoot = getProjectRoot();

            // [Optimized] Reload rules only when the project root changes
            if (newRoot !== currentRoot) {
                console.log(`[SnapTeX] Switching context: ${currentRoot} -> ${newRoot}`);
                currentRoot = newRoot;
                renderer.reloadAllRules(newRoot);
            }

            TexPreviewPanel.currentPanel?.update();
        }
    }, null, context.subscriptions);
}

// [New] Helper function to setup Reverse Sync listener (Preview -> Editor)
function setupReverseSync(panel: TexPreviewPanel | undefined) {
    if (panel && panel.panel) {
        panel.panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'revealLine':
                        const index = message.index;
                        // Calculate editor line from block index
                        const line = renderer.getLineByBlockIndex(index);
                        const editor = vscode.window.activeTextEditor;
                        if (editor) {
                            const range = editor.document.lineAt(line).range;
                            // Set selection and scroll to center
                            editor.selection = new vscode.Selection(range.start, range.end);
                            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                        }
                        return;
                }
            },
            null,
            []
        );
    }
}

export function deactivate() {
    console.log('[SnapTeX] Extension deactivated.');
}