import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { SmartRenderer } from './renderer';
import { TexPreviewPanel } from './panel';

// Global unique rendering engine instance
const renderer = new SmartRenderer();

/**
 * Smartly get the current project root directory
 */
function getProjectRoot(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (workspaceFolder) {
            return workspaceFolder.uri.fsPath;
        }
        return path.dirname(editor.document.uri.fsPath);
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Extension activation entry
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('[SnapTeX] Extension is now active.');

    const globalConfigPath = path.join(os.homedir(), '.snaptex.global.js');
    let currentRoot = getProjectRoot();

    // 1. Initial load
    renderer.reloadAllRules(currentRoot);

    // 2. Register startup command
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.start', () => {
            const panel = TexPreviewPanel.createOrShow(context.extensionPath, renderer);
            setupReverseSync(panel);
        })
    );

    // 3. Register Forward Sync Command (Editor -> Preview)
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.syncToPreview', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !TexPreviewPanel.currentPanel) { return; }

            const line = editor.selection.active.line;
            const blockIndex = renderer.getBlockIndexByLine(line);

            console.log(`[SnapTeX] Sync to preview: Line ${line} -> Block ${blockIndex}`);

            TexPreviewPanel.currentPanel.postMessage({
                command: 'scrollToBlock',
                index: blockIndex
            });
        })
    );

    // 4. Watch global config
    const globalWatcher = vscode.workspace.createFileSystemWatcher(globalConfigPath);
    globalWatcher.onDidChange(() => {
        console.log('[TeX Preview] Global config change detected, reloading...');
        renderer.reloadAllRules(getProjectRoot());
        TexPreviewPanel.currentPanel?.update();
    });
    context.subscriptions.push(globalWatcher);

    // 5. Watch workspace config
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

    // 6. Watch document modification
    let debounceTimer: NodeJS.Timeout | undefined;
    const RENDER_DEBOUNCE = 100;
    vscode.workspace.onDidChangeTextDocument(e => {
        if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
            if (debounceTimer) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(() => {
                if (TexPreviewPanel.currentPanel) {
                    TexPreviewPanel.currentPanel.update();
                }
            }, RENDER_DEBOUNCE);
        }
    }, null, context.subscriptions);

    // 7. Watch switch editor events
    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            const newRoot = getProjectRoot();
            if (newRoot !== currentRoot) {
                console.log(`[SnapTeX] Switching context: ${currentRoot} -> ${newRoot}`);
                currentRoot = newRoot;
                renderer.reloadAllRules(newRoot);
            }
            TexPreviewPanel.currentPanel?.update();
        }
    }, null, context.subscriptions);
}

// [Updated] Robust Reverse Sync Logic (Preview -> Editor)
function setupReverseSync(panel: TexPreviewPanel | undefined) {
    if (panel && panel.panel) {
        panel.panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'revealLine':
                        const index = message.index;
                        const line = renderer.getLineByBlockIndex(index);

                        // 1. Get the URI of the source document associated with the current preview
                        const targetUri = panel.sourceUri;
                        if (!targetUri) {
                            console.warn('[SnapTeX] Reverse sync failed: Unknown source document.');
                            return;
                        }

                        // 2. Attempt to find an already visible editor matching the URI
                        //    This correctly handles split views and multiple tabs.
                        let targetEditor = vscode.window.visibleTextEditors.find(
                            e => e.document.uri.toString() === targetUri.toString()
                        );

                        // 3. If not found (e.g., file closed or hidden), try to open it
                        if (!targetEditor) {
                            try {
                                const doc = await vscode.workspace.openTextDocument(targetUri);
                                targetEditor = await vscode.window.showTextDocument(doc, {
                                    preview: false,
                                    viewColumn: vscode.ViewColumn.One
                                });
                            } catch (e) {
                                console.error('[SnapTeX] Failed to open document for reverse sync:', e);
                                return;
                            }
                        } else {
                            // If found, bring it to focus
                            await vscode.window.showTextDocument(targetEditor.document, {
                                viewColumn: targetEditor.viewColumn
                            });
                        }

                        // 4. Perform jump and center alignment
                        if (targetEditor) {
                            console.log(`[SnapTeX] Jumping to ${targetUri.fsPath}:${line}`);
                            const range = targetEditor.document.lineAt(line).range;
                            targetEditor.selection = new vscode.Selection(range.start, range.end);
                            targetEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
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