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

// === GLOBAL STATE ===
// Lock flag to prevent "Scroll Loop" (Editor -> Preview -> Editor -> ...)
let isSyncingFromPreview = false;
let syncLockTimer: NodeJS.Timeout | undefined;

// Tracks which document URI is currently displayed in the preview panel.
let currentRenderedUri: vscode.Uri | undefined = undefined;

// Cache for the cursor's relative position on screen (0.0 to 1.0).
let activeCursorScreenRatio: number = 0.5;

// [NEW] Subscription for panel events to handle initial sync
let panelLoadSubscription: vscode.Disposable | undefined;

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
function getAnchorContext(doc: vscode.TextDocument, line: number, char?: number): string {
    if (line < 0 || line >= doc.lineCount) {return "";}

    const lineObj = doc.lineAt(line);
    const lineText = lineObj.text;

    let rawSnippet = "";

    // If character position is provided (Cursor Sync), extract window around it
    if (char !== undefined && char >= 0) {
        // Grab ~20 chars before and ~30 chars after the cursor
        const start = Math.max(0, char - 20);
        const end = Math.min(lineText.length, char + 30);
        rawSnippet = lineText.substring(start, end);
    } else {
        // Fallback (Scroll Sync): Use the beginning of the line
        rawSnippet = lineText.substring(0, 60);
    }

    let clean = rawSnippet
        .replace(/\\[a-zA-Z]+\*?\{?/g, ' ')
        .replace(/[{}$%]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (clean.length < 5 && char !== undefined) {
        clean = lineText.substring(0, 60)
            .replace(/\\[a-zA-Z]+\*?\{?/g, ' ')
            .replace(/[{}$%]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    if (clean.length < 5) {return "";}
    return clean.substring(0, 40);
}

// === Core Logic for Controlled Rendering ===

/**
 * Central function to handle preview updates.
 */
function updatePreview(context: vscode.ExtensionContext, force: boolean = false) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !TexPreviewPanel.currentPanel) { return; }

    const lang = editor.document.languageId;
    if (lang !== 'latex' && lang !== 'tex') {
        return;
    }

    if (!force && currentRenderedUri && editor.document.uri.toString() !== currentRenderedUri.toString()) {
        return;
    }

    currentRenderedUri = editor.document.uri;

    const newRoot = getProjectRoot();
    renderer.reloadAllRules(newRoot);
    TexPreviewPanel.currentPanel.update();
}

/**
 * Central Sync Helper
 */
function triggerSync(editor: vscode.TextEditor, targetLine: number, isAutoScroll: boolean = false, viewRatio: number = 0.5, targetChar?: number) {
    if (!TexPreviewPanel.currentPanel) {return;}

    if (currentRenderedUri && editor.document.uri.toString() !== currentRenderedUri.toString()) {
        return;
    }

    const filePath = editor.document.uri.fsPath;
    const flatLine = renderer.getFlattenedLine(filePath, targetLine);

    if (flatLine === -1) {return;}

    const { index, ratio } = renderer.getBlockIndexByLine(flatLine);
    const anchor = getAnchorContext(editor.document, targetLine, targetChar);

    TexPreviewPanel.currentPanel.postMessage({
        command: 'scrollToBlock',
        index: index,
        ratio: ratio,
        anchor: anchor,
        auto: isAutoScroll,
        viewRatio: viewRatio
    });
}

/**
 * [NEW] Hook up panel events (Load complete -> Sync)
 * This ensures the preview jumps to the editor's cursor position immediately after loading.
 */
function hookPanelEvents(panel: TexPreviewPanel) {
    if (panelLoadSubscription) {
        panelLoadSubscription.dispose();
    }
    panelLoadSubscription = panel.onWebviewLoaded(() => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            // [MODIFIED] No delay needed here. The webview's pendingScroll queue will handle the timing.
            triggerSync(editor, editor.selection.active.line, true, activeCursorScreenRatio, editor.selection.active.character);
        }
    });
}

/**
 * Extension activation entry
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('[SnapTeX] Extension is now active.');

    const globalConfigPath = path.join(os.homedir(), '.snaptex.global.js');
    let currentRoot = getProjectRoot();

    renderer.reloadAllRules(currentRoot);

    if (vscode.window.registerWebviewPanelSerializer) {
        vscode.window.registerWebviewPanelSerializer(TexPreviewPanel.viewType, {
            async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any) {
                console.log('[SnapTeX] Reviving Webview Panel...');
                TexPreviewPanel.revive(webviewPanel, context.extensionPath, renderer);
                // [NEW] Hook events on revival
                if (TexPreviewPanel.currentPanel) {
                    hookPanelEvents(TexPreviewPanel.currentPanel);
                }
            }
        });
    }

    // 2. Register startup command (Ctrl+K V)
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.start', () => {
            if (TexPreviewPanel.currentPanel) {
                updatePreview(context, true);
            } else {
                TexPreviewPanel.createOrShow(context.extensionPath, renderer);
                if (vscode.window.activeTextEditor) {
                    currentRenderedUri = vscode.window.activeTextEditor.document.uri;
                }
                // [NEW] Hook events on creation
                if (TexPreviewPanel.currentPanel) {
                    hookPanelEvents(TexPreviewPanel.currentPanel);
                }
            }
        })
    );

    // 3. Register Forward Sync Command (Manual Ctrl+Alt+N)
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.syncToPreview', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                triggerSync(editor, editor.selection.active.line, false, activeCursorScreenRatio, editor.selection.active.character);
            }
        })
    );

    // 4. Register Reverse Sync Command (Preview -> Editor)
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.internal.revealLine', async (uri: vscode.Uri, index: number, ratio: number, anchor: string) => {
            isSyncingFromPreview = true;
            if (syncLockTimer) { clearTimeout(syncLockTimer); }
            syncLockTimer = setTimeout(() => { isSyncingFromPreview = false; }, 500);

            const flatLine = renderer.getLineByBlockIndex(index, ratio);
            const originalLoc = renderer.getOriginalPosition(flatLine);
            if (!originalLoc) { return; }

            const targetUri = vscode.Uri.file(originalLoc.file);
            let targetLine = originalLoc.line;

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

    // 5. Internal Sync Scroll (Preview -> Editor)
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.internal.syncScroll', async (index: number, ratio: number) => {
            isSyncingFromPreview = true;
            if (syncLockTimer) { clearTimeout(syncLockTimer); }
            syncLockTimer = setTimeout(() => { isSyncingFromPreview = false; }, 500);

            const flatLine = renderer.getLineByBlockIndex(index, ratio);
            const originalLoc = renderer.getOriginalPosition(flatLine);
            if (!originalLoc) { return; }

            const targetUri = vscode.Uri.file(originalLoc.file);
            const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === targetUri.toString());

            if (editor) {
                const line = Math.max(0, Math.min(originalLoc.line, editor.document.lineCount - 1));
                const range = new vscode.Range(line, 0, line, 0);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            }
        })
    );


    // =========================================================
    //        1. Cursor Move Listener (Cursor -> Preview)
    // =========================================================
    let cursorDebounceTimer: NodeJS.Timeout | undefined;

    vscode.window.onDidChangeTextEditorSelection(e => {
        const editor = e.textEditor;
        if (editor !== vscode.window.activeTextEditor) {return;}

        const cursorLine = e.selections[0].active.line;
        const cursorChar = e.selections[0].active.character;
        const visibleRange = editor.visibleRanges[0];

        if (visibleRange) {
            if (visibleRange.contains(e.selections[0].active)) {
                const totalVisibleLines = visibleRange.end.line - visibleRange.start.line;
                if (totalVisibleLines > 0) {
                    const ratio = (cursorLine - visibleRange.start.line) / totalVisibleLines;
                    activeCursorScreenRatio = Math.max(0.1, Math.min(0.9, ratio));
                } else {
                    activeCursorScreenRatio = 0.5;
                }
            }
        }

        if (!TexPreviewPanel.currentPanel) {return;}
        if (isSyncingFromPreview) {return;}

        const config = vscode.workspace.getConfiguration('snaptex');
        const enableSync = config.get<boolean>('autoScrollSync', true);
        const delay = config.get<number>('autoScrollDelay', 200);

        if (!enableSync) {return;}

        if (cursorDebounceTimer) {clearTimeout(cursorDebounceTimer);}
        cursorDebounceTimer = setTimeout(() => {
            triggerSync(editor, cursorLine, true, activeCursorScreenRatio, cursorChar);
        }, delay);
    }, null, context.subscriptions);


    // =========================================================
    //        2. Scroll Listener (Scroll Sync)
    // =========================================================
    let throttleTimer: NodeJS.Timeout | undefined;

    vscode.window.onDidChangeTextEditorVisibleRanges(e => {
        const editor = e.textEditor;

        if (editor !== vscode.window.activeTextEditor) {return;}
        if (!TexPreviewPanel.currentPanel) {return;}
        if (isSyncingFromPreview) {return;}

        const config = vscode.workspace.getConfiguration('snaptex');
        const enableSync = config.get<boolean>('autoScrollSync', true);
        const delay = config.get<number>('autoScrollDelay', 200);

        if (!enableSync) {return;}

        if (throttleTimer) {return;}
        throttleTimer = setTimeout(() => {
            throttleTimer = undefined;
            if (e.visibleRanges.length > 0) {
                const range = e.visibleRanges[0];
                const visibleHeight = range.end.line - range.start.line;
                const targetLine = Math.floor(range.start.line + (visibleHeight * activeCursorScreenRatio));

                triggerSync(editor, targetLine, true, activeCursorScreenRatio);
            }
        }, delay);
    }, null, context.subscriptions);


    // Watchers & Other Listeners (Keep as is)
    const globalWatcher = vscode.workspace.createFileSystemWatcher(globalConfigPath);
    globalWatcher.onDidChange(() => {
        renderer.reloadAllRules(getProjectRoot());
        TexPreviewPanel.currentPanel?.update();
    });
    context.subscriptions.push(globalWatcher);

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

    let debounceTimer: NodeJS.Timeout | undefined;
    vscode.workspace.onDidChangeTextDocument(e => {
        const editor = vscode.window.activeTextEditor;
        if (editor && e.document === editor.document) {
            const config = vscode.workspace.getConfiguration('snaptex');
            const enableLivePreview = config.get<boolean>('livePreview', true);
            const debounceDelay = config.get<number>('delay', 200);

            if (enableLivePreview) {
                if (debounceTimer) { clearTimeout(debounceTimer); }
                debounceTimer = setTimeout(() => {
                    updatePreview(context, false);
                }, debounceDelay);
            }
        }
    }, null, context.subscriptions);

    vscode.workspace.onDidSaveTextDocument(e => {
        const editor = vscode.window.activeTextEditor;
        if (editor && e === editor.document) {
            updatePreview(context, false);
        }
    }, null, context.subscriptions);

    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            const config = vscode.workspace.getConfiguration('snaptex');
            const renderOnSwitch = config.get<boolean>('renderOnSwitch', true);

            if (renderOnSwitch) {
                updatePreview(context, true);
            }

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