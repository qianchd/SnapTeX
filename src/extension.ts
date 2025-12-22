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
 * Helper: Extract a multi-word context string around the cursor
 * This removes LaTeX commands to increase match probability in the rendered HTML.
 */
function getAnchorContext(editor: vscode.TextEditor): string {
    const position = editor.selection.active;
    const lineText = editor.document.lineAt(position.line).text;

    // 1. Define a window around the cursor (e.g., +/- 30 characters)
    const startChar = Math.max(0, position.character - 10);
    const endChar = Math.min(lineText.length, position.character + 10);
    const rawSnippet = lineText.substring(startChar, endChar);

    // 2. Clean up LaTeX syntax to get "pure text" (heuristic)
    // Remove command keywords (e.g. \textbf{...} -> { ... })
    let clean = rawSnippet.replace(/\\[a-zA-Z]+\*?/g, ' ');
    // Remove braces, $, %, etc.
    clean = clean.replace(/[{}$%]/g, ' ');
    // Collapse whitespace
    clean = clean.replace(/\s+/g, ' ').trim();

    // 3. Ensure we have a decent length (min 5 chars)
    if (clean.length < 5) {
        // Fallback: simple word under cursor if context is too noisy (like pure math)
        const wordRange = editor.document.getWordRangeAtPosition(position);
        return wordRange ? editor.document.getText(wordRange) : "";
    }

    return clean;
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

    if (vscode.window.registerWebviewPanelSerializer) {
        vscode.window.registerWebviewPanelSerializer(TexPreviewPanel.viewType, {
            async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any) {
                console.log('[SnapTeX] Reviving Webview Panel...');
                // 恢复面板，并重新绑定 renderer
                TexPreviewPanel.revive(webviewPanel, context.extensionPath, renderer);
                // 恢复反向同步监听
                setupReverseSync(TexPreviewPanel.currentPanel);
            }
        });
    }

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

            const position = editor.selection.active;
            const line = position.line;

            // [Updated] Get index AND ratio for precise positioning
            const { index, ratio } = renderer.getBlockIndexByLine(line);

            // [New] Get multi-word context anchor
            const anchor = getAnchorContext(editor);

            console.log(`[SnapTeX] Sync to preview: Line ${line} -> Block ${index} (Anchor: "${anchor}")`);

            TexPreviewPanel.currentPanel.postMessage({
                command: 'scrollToBlock',
                index: index,
                ratio: ratio,
                anchor: anchor // Send the robust context string
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
                        const ratio = message.ratio || 0;
                        const anchor = message.anchor || "";

                        // 1. Default: Calculate precise line using ratio
                        let targetLine = renderer.getLineByBlockIndex(index, ratio);

                        // 2. Exact URI matching for multi-file support
                        const targetUri = panel.sourceUri;
                        if (!targetUri) { return; }

                        // 3. Find matching visible editor
                        let targetEditor = vscode.window.visibleTextEditors.find(
                            e => e.document.uri.toString() === targetUri.toString()
                        );

                        // 4. Auto-open if not visible
                        if (!targetEditor) {
                            try {
                                const doc = await vscode.workspace.openTextDocument(targetUri);
                                targetEditor = await vscode.window.showTextDocument(doc, {
                                    preview: false,
                                    viewColumn: vscode.ViewColumn.One
                                });
                            } catch (e) {
                                console.error('[SnapTeX] Failed to open document:', e);
                                return;
                            }
                        } else {
                            // If found, bring focus
                            await vscode.window.showTextDocument(targetEditor.document, {
                                viewColumn: targetEditor.viewColumn
                            });
                        }

                        // 5. [New] Refine position using anchor text search
                        // We search for the anchor in the raw document text around the estimated line
                        if (targetEditor && anchor && anchor.length > 3) {
                            const blockInfo = renderer.getBlockInfo(index);
                            if (blockInfo) {
                                // Search window: The specific block range
                                const startLine = blockInfo.start;
                                const endLine = blockInfo.start + blockInfo.count;
                                const safeEndLine = Math.min(endLine, targetEditor.document.lineCount);

                                if (startLine < targetEditor.document.lineCount) {
                                    const blockRange = new vscode.Range(startLine, 0, safeEndLine, 0);
                                    const blockText = targetEditor.document.getText(blockRange);

                                    // Search for the clicked text in the source block
                                    const matchIndex = blockText.indexOf(anchor);
                                    if (matchIndex !== -1) {
                                        const preText = blockText.substring(0, matchIndex);
                                        const lineOffset = preText.split('\n').length - 1;
                                        targetLine = startLine + lineOffset;
                                    }
                                }
                            }
                        }

                        // 6. Jump to the line
                        if (targetEditor) {
                            console.log(`[SnapTeX] Jumping to ${targetUri.fsPath}:${targetLine}`);
                            const range = targetEditor.document.lineAt(targetLine).range;
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