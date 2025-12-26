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

// === Core Logic for Controlled Rendering ===

// Tracks which document URI is currently displayed in the preview panel.
let currentRenderedUri: vscode.Uri | undefined = undefined;

/**
 * Central function to handle preview updates.
 * @param context Extension context
 * @param force If true, it forces the preview to switch to the current editor (used for Manual trigger / Ctrl+K V).
 */
function updatePreview(context: vscode.ExtensionContext, force: boolean = false) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !TexPreviewPanel.currentPanel) { return; }

    // 1. Language Guard: Only render .tex or .latex files
    const lang = editor.document.languageId;
    if (lang !== 'latex' && lang !== 'tex') {
        return;
    }

    // 2. Lock Guard:
    // If we are NOT forcing an update (e.g., just typing), ensure we are typing
    // in the document that is currently being previewed.
    // If I am editing Doc B, but the preview is locked to Doc A, ignore this update.
    if (!force && currentRenderedUri && editor.document.uri.toString() !== currentRenderedUri.toString()) {
        return;
    }

    // 3. Update State
    currentRenderedUri = editor.document.uri;

    // 4. Reload Rules (in case project root changed) and Render
    const newRoot = getProjectRoot();
    renderer.reloadAllRules(newRoot);
    TexPreviewPanel.currentPanel.update();
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

    // 2. Register startup command (Ctrl+K V)
    // If panel exists, this acts as a "Manual Refresh/Switch" button.
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.start', () => {
            if (TexPreviewPanel.currentPanel) {
                // Panel exists: Force render the current editor content
                updatePreview(context, true);
            } else {
                // Panel does not exist: Create it
                TexPreviewPanel.createOrShow(context.extensionPath, renderer);
                // Set current rendered URI
                if (vscode.window.activeTextEditor) {
                    currentRenderedUri = vscode.window.activeTextEditor.document.uri;
                }
            }
        })
    );

    // 3. Register Forward Sync Command (Editor -> Preview)
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.syncToPreview', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !TexPreviewPanel.currentPanel) { return; }

            // Guard: Only sync if the editor matches the preview
            if (currentRenderedUri && editor.document.uri.toString() !== currentRenderedUri.toString()) {
                return;
            }

            const position = editor.selection.active;
            const originalLine = position.line;
            const filePath = editor.document.uri.fsPath;

            // Map original file/line to flattened line
            const flatLine = renderer.getFlattenedLine(filePath, originalLine);
            if (flatLine === -1) {
                console.warn('[SnapTeX] Could not map source line to preview');
                return;
            }

            const { index, ratio } = renderer.getBlockIndexByLine(flatLine);
            const anchor = getAnchorContext(editor);

            TexPreviewPanel.currentPanel.postMessage({
                command: 'scrollToBlock',
                index: index,
                ratio: ratio,
                anchor: anchor
            });
        })
    );

    // 4. Register Reverse Sync Command (Preview -> Editor)
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.internal.revealLine', async (uri: vscode.Uri, index: number, ratio: number, anchor: string) => {
            // 1. Get Flattened Line from Block Index
            const flatLine = renderer.getLineByBlockIndex(index, ratio);

            // 2. Map Flattened Line -> Original File/Line
            const originalLoc = renderer.getOriginalPosition(flatLine);
            if (!originalLoc) {
                console.warn('[SnapTeX] Could not map preview location back to source');
                return;
            }

            const targetUri = vscode.Uri.file(originalLoc.file);
            let targetLine = originalLoc.line;

            // 3. Open correct document
            let targetEditor = vscode.window.visibleTextEditors.find(
                e => e.document.uri.toString() === targetUri.toString()
            );

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

            // 4. Refine position (Anchor search)
            if (targetEditor && anchor && anchor.length > 3) {
                const startSearch = Math.max(0, targetLine - 5);
                const endSearch = Math.min(targetEditor.document.lineCount, targetLine + 10);
                const range = new vscode.Range(startSearch, 0, endSearch, 0);
                const text = targetEditor.document.getText(range);
                const idx = text.indexOf(anchor);
                if (idx !== -1) {
                    const prefix = text.substring(0, idx);
                    targetLine = startSearch + prefix.split('\n').length - 1;
                }
            }

            // 5. Jump and Flash
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

    // =========================================================
    //               Revised Event Listeners
    // =========================================================

    // 7. Configurable Live Preview (Typing)
    let debounceTimer: NodeJS.Timeout | undefined;

    vscode.workspace.onDidChangeTextDocument(e => {
        const editor = vscode.window.activeTextEditor;

        // Ensure the event belongs to the active editor
        if (editor && e.document === editor.document) {

            const config = vscode.workspace.getConfiguration('snaptex');
            const enableLivePreview = config.get<boolean>('livePreview', true);
            const debounceDelay = config.get<number>('delay', 200);

            if (enableLivePreview) {
                if (debounceTimer) { clearTimeout(debounceTimer); }
                debounceTimer = setTimeout(() => {
                    // force = false.
                    // If renderOnSwitch is false and we are in a new file,
                    // currentRenderedUri will not match editor.document.uri,
                    // so updatePreview will correctly abort.
                    updatePreview(context, false);
                }, debounceDelay);
            }
        }
    }, null, context.subscriptions);

    // 8. Update on Save
    vscode.workspace.onDidSaveTextDocument(e => {
        const editor = vscode.window.activeTextEditor;
        if (editor && e === editor.document) {
            // force = false. Respects the lock.
            updatePreview(context, false);
        }
    }, null, context.subscriptions);

    // 9. Watch Switch Editor (Tab Change)
    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            const config = vscode.workspace.getConfiguration('snaptex');
            const renderOnSwitch = config.get<boolean>('renderOnSwitch', true);

            if (renderOnSwitch) {
                // If auto-switch is ON, force the preview to the new file
                updatePreview(context, true);
            } else {
                // If auto-switch is OFF, do nothing.
                // currentRenderedUri stays on the OLD file.
                // Typing events in the NEW file will be ignored by updatePreview(false).
                // User must press Ctrl+K V to trigger updatePreview(true).
            }

            // Update project root logic if needed
            const newRoot = getProjectRoot();
            if (newRoot !== currentRoot) {
                currentRoot = newRoot;
            }
        }
    }, null, context.subscriptions);
}

export function deactivate() {
    console.log('[SnapTeX] Extension deactivated.');
}