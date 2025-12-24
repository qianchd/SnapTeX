import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { SmartRenderer } from './renderer';
import { TexPreviewPanel } from './panel';

// Global unique rendering engine instance
const renderer = new SmartRenderer();

// --- Decoration Types for Flash Animation ---
const flashDecorationTypeHigh = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
    isWholeLine: true,
});

const flashDecorationType80 = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'color-mix(in srgb, var(--vscode-editor-wordHighlightBackground) 80%, transparent)',
    isWholeLine: true,
});

const flashDecorationType60 = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'color-mix(in srgb, var(--vscode-editor-wordHighlightBackground) 60%, transparent)',
    isWholeLine: true,
});

const flashDecorationType40 = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'color-mix(in srgb, var(--vscode-editor-wordHighlightBackground) 40%, transparent)',
    isWholeLine: true,
});

const flashDecorationType10 = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'color-mix(in srgb, var(--vscode-editor-wordHighlightBackground) 10%, transparent)',
    isWholeLine: true,
});

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
 */
function getAnchorContext(editor: vscode.TextEditor): string {
    const position = editor.selection.active;
    const lineText = editor.document.lineAt(position.line).text;
    const startChar = Math.max(0, position.character - 10);
    const endChar = Math.min(lineText.length, position.character + 10);
    const rawSnippet = lineText.substring(startChar, endChar);
    let clean = rawSnippet.replace(/\\[a-zA-Z]+\*?/g, ' ');
    clean = clean.replace(/[{}$%]/g, ' ');
    clean = clean.replace(/\s+/g, ' ').trim();

    if (clean.length < 5) {
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
                TexPreviewPanel.revive(webviewPanel, context.extensionPath, renderer);
            }
        });
    }

    // 2. Register startup command
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.start', () => {
            TexPreviewPanel.createOrShow(context.extensionPath, renderer);
        })
    );

    // 3. Register Forward Sync Command (Editor -> Preview)
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.syncToPreview', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !TexPreviewPanel.currentPanel) { return; }

            const position = editor.selection.active;
            const line = position.line;
            const { index, ratio } = renderer.getBlockIndexByLine(line);
            const anchor = getAnchorContext(editor);

            console.log(`[SnapTeX] Sync to preview: Line ${line} -> Block ${index}`);

            TexPreviewPanel.currentPanel.postMessage({
                command: 'scrollToBlock',
                index: index,
                ratio: ratio,
                anchor: anchor
            });
        })
    );

    // 4. [NEW] Register Internal Reverse Sync Command (Preview -> Editor)
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.internal.revealLine', async (uri: vscode.Uri, index: number, ratio: number, anchor: string) => {
            // Ensure URI is a proper vscode.Uri object
            const targetUri = uri instanceof vscode.Uri ? uri : vscode.Uri.file(uri as any);

            // 1. Calculate default target line
            let targetLine = renderer.getLineByBlockIndex(index, ratio);

            // 2. Find matching visible editor
            let targetEditor = vscode.window.visibleTextEditors.find(
                e => e.document.uri.toString() === targetUri.toString()
            );

            // 3. Open if not visible
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
                await vscode.window.showTextDocument(targetEditor.document, {
                    viewColumn: targetEditor.viewColumn
                });
            }

            // 4. Refine position using anchor text search
            if (targetEditor && anchor && anchor.length > 3) {
                const blockInfo = renderer.getBlockInfo(index);
                if (blockInfo) {
                    const startLine = blockInfo.start;
                    const endLine = blockInfo.start + blockInfo.count;
                    const safeEndLine = Math.min(endLine, targetEditor.document.lineCount);

                    if (startLine < targetEditor.document.lineCount) {
                        const blockRange = new vscode.Range(startLine, 0, safeEndLine, 0);
                        const blockText = targetEditor.document.getText(blockRange);
                        const matchIndex = blockText.indexOf(anchor);
                        if (matchIndex !== -1) {
                            const preText = blockText.substring(0, matchIndex);
                            const lineOffset = preText.split('\n').length - 1;
                            targetLine = startLine + lineOffset;
                        }
                    }
                }
            }

            // 5. Jump with Flash Animation
            if (targetEditor) {
                const safeLine = Math.max(0, Math.min(targetLine, targetEditor.document.lineCount - 1));
                const lineObj = targetEditor.document.lineAt(safeLine);
                const range = lineObj.range;

                targetEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                targetEditor.selection = new vscode.Selection(range.start, range.start);

                const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
                const flashSequence = [
                    { decoration: flashDecorationTypeHigh, duration: 300 },
                    { decoration: flashDecorationType80, duration: 40 },
                    { decoration: flashDecorationType60, duration: 40 },
                    { decoration: flashDecorationType40, duration: 150 },
                    { decoration: flashDecorationType10, duration: 240 },
                ];

                // Fire and forget animation
                (async () => {
                    for (let i = 0; i < flashSequence.length; i++) {
                        const step = flashSequence[i];
                        const prevStep = i > 0 ? flashSequence[i - 1] : null;
                        targetEditor!.setDecorations(step.decoration, [range]);
                        if (prevStep) {
                            targetEditor!.setDecorations(prevStep.decoration, []);
                        }
                        await sleep(step.duration);
                    }
                    const lastStep = flashSequence[flashSequence.length - 1];
                    targetEditor!.setDecorations(lastStep.decoration, []);
                })();
            }
        })
    );

    // 5. Watch global config
    const globalWatcher = vscode.workspace.createFileSystemWatcher(globalConfigPath);
    globalWatcher.onDidChange(() => {
        renderer.reloadAllRules(getProjectRoot());
        TexPreviewPanel.currentPanel?.update();
    });
    context.subscriptions.push(globalWatcher);

    // 6. Watch workspace config
    if (currentRoot) {
        const workspaceWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(currentRoot, 'snaptex.config.js')
        );
        workspaceWatcher.onDidChange(() => {
            renderer.reloadAllRules(currentRoot);
            TexPreviewPanel.currentPanel?.update();
        });
        context.subscriptions.push(workspaceWatcher);
    }

    // 7. Watch document modification
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

    // 8. Watch switch editor events
    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            const newRoot = getProjectRoot();
            if (newRoot !== currentRoot) {
                currentRoot = newRoot;
                renderer.reloadAllRules(newRoot);
            }
            TexPreviewPanel.currentPanel?.update();
        }
    }, null, context.subscriptions);
}

export function deactivate() {
    console.log('[SnapTeX] Extension deactivated.');
}