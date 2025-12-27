import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { SmartRenderer } from './renderer';
import { TexPreviewPanel } from './panel';

// =========================================================
// 1. Decoration Types for Flash Animation
//    (Visual feedback when jumping to a line)
// =========================================================

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

// =========================================================
// 2. Global State Management
// =========================================================

// Lock flag to prevent "Scroll Loop" (Editor -> Preview -> Editor -> ...)
let isSyncingFromPreview = false;
let syncLockTimer: NodeJS.Timeout | undefined;

// Prevent ratio update during scrolling: Editor Scroll -> Cursor "moves" relatively -> Ratio changes (Bad!)
let isEditorScrolling = false;
let scrollEndTimer: NodeJS.Timeout | undefined;

let currentRenderedUri: vscode.Uri | undefined = undefined;
let activeCursorScreenRatio: number = 0.5; // Default center
let panelLoadSubscription: vscode.Disposable | undefined;

// Helper: Debounce function
const debounce = (func: Function, wait: number) => {
    let timeout: NodeJS.Timeout | undefined;
    return (...args: any[]) => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
};

// =========================================================
// 3. Helper Functions
// =========================================================

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

function getAnchorContext(doc: vscode.TextDocument, line: number, char?: number): string {
    if (line < 0 || line >= doc.lineCount) { return ""; }
    const lineObj = doc.lineAt(line);
    const lineText = lineObj.text;
    let rawSnippet = "";

    if (char !== undefined && char >= 0) {
        const start = Math.max(0, char - 20);
        const end = Math.min(lineText.length, char + 30);
        rawSnippet = lineText.substring(start, end);
    } else {
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
    if (clean.length < 5) { return ""; }
    return clean.substring(0, 40);
}

// Logic extracted from original 'snaptex.internal.revealLine' to save lines and improve readability
async function performFlashAnimation(editor: vscode.TextEditor, range: vscode.Range) {
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const flashSequence = [
        { decoration: flashDecorationTypeHigh, duration: 300 },
        { decoration: flashDecorationType80, duration: 40 },
        { decoration: flashDecorationType60, duration: 40 },
        { decoration: flashDecorationType40, duration: 150 },
        { decoration: flashDecorationType10, duration: 240 },
    ];

    for (let i = 0; i < flashSequence.length; i++) {
        const step = flashSequence[i];
        const prevStep = i > 0 ? flashSequence[i - 1] : null;
        editor.setDecorations(step.decoration, [range]);
        if (prevStep) {
            editor.setDecorations(prevStep.decoration, []);
        }
        await sleep(step.duration);
    }
    const lastStep = flashSequence[flashSequence.length - 1];
    editor.setDecorations(lastStep.decoration, []);
}

// =========================================================
// 4. Extension Activation
// =========================================================

export function activate(context: vscode.ExtensionContext) {
    console.log('[SnapTeX] Activated!');

    const renderer = new SmartRenderer();
    renderer.reloadAllRules(getProjectRoot());

    // --- Config Watcher ---
    const configWatcher = vscode.workspace.createFileSystemWatcher('**/snaptex.config.js');
    configWatcher.onDidChange(() => {
        renderer.reloadAllRules(getProjectRoot());
        TexPreviewPanel.currentPanel?.update();
    });
    context.subscriptions.push(configWatcher);

    // --- Core Logic: Trigger Sync (Editor -> Preview) ---
    const triggerSyncToPreview = (
        editor: vscode.TextEditor,
        targetLine: number,
        isAutoScroll: boolean = false,
        viewRatio: number = 0.5,
        targetChar?: number
    ) => {
        if (!TexPreviewPanel.currentPanel) { return; }
        if (currentRenderedUri && editor.document.uri.toString() !== currentRenderedUri.toString()) { return; }

        const filePath = editor.document.uri.fsPath;
        const flatLine = renderer.getFlattenedLine(filePath, targetLine);

        if (flatLine === -1) { return; }

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
    };

    // --- Core Logic: Hook Events on Panel Load ---
    const hookPanelEvents = (panel: TexPreviewPanel) => {
        if (panelLoadSubscription) { panelLoadSubscription.dispose(); }
        panelLoadSubscription = panel.onWebviewLoaded(() => {
            const editor = vscode.window.activeTextEditor;
            if (editor && currentRenderedUri && editor.document.uri.toString() === currentRenderedUri.toString()) {
                // Initial jump to cursor position
                triggerSyncToPreview(
                    editor,
                    editor.selection.active.line,
                    true,
                    activeCursorScreenRatio,
                    editor.selection.active.character
                );
            }
        });
    };

    // --- Core Logic: Update Preview Content ---
    const updatePreview = (force: boolean = false) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !TexPreviewPanel.currentPanel) { return; }
        if (!force && currentRenderedUri && editor.document.uri.toString() !== currentRenderedUri.toString()) { return; }

        currentRenderedUri = editor.document.uri;
        renderer.reloadAllRules(getProjectRoot());
        TexPreviewPanel.currentPanel.update();
    };


    // =========================================================
    // [RESTORED] Webview Serializer (Session Restore)
    // =========================================================
    if (vscode.window.registerWebviewPanelSerializer) {
        vscode.window.registerWebviewPanelSerializer(TexPreviewPanel.viewType, {
            async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any) {
                console.log('[SnapTeX] Reviving Webview Panel...');
                TexPreviewPanel.revive(webviewPanel, context.extensionPath, renderer);
                if (TexPreviewPanel.currentPanel) {
                    hookPanelEvents(TexPreviewPanel.currentPanel);
                    // Try to restore rendered URI from active editor if possible
                    if (vscode.window.activeTextEditor) {
                        currentRenderedUri = vscode.window.activeTextEditor.document.uri;
                        updatePreview(true);
                    }
                }
            }
        });
    }

    // =========================================================
    // Commands Registration
    // =========================================================

    // 1. snaptex.start
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.start', () => {
            if (TexPreviewPanel.currentPanel) {
                updatePreview(true);
            } else {
                TexPreviewPanel.createOrShow(context.extensionPath, renderer);
                if (vscode.window.activeTextEditor) {
                    currentRenderedUri = vscode.window.activeTextEditor.document.uri;
                }
                if (TexPreviewPanel.currentPanel) {
                    hookPanelEvents(TexPreviewPanel.currentPanel);
                }
            }
        })
    );

    // 2. snaptex.syncToPreview
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.syncToPreview', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                triggerSyncToPreview(
                    editor,
                    editor.selection.active.line,
                    false, // Manual sync -> Flash highlight
                    activeCursorScreenRatio,
                    editor.selection.active.character
                );
            }
        })
    );

    // 3. snaptex.internal.revealLine (Preview Click -> Editor)
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
                await vscode.window.showTextDocument(targetEditor.document, { viewColumn: targetEditor.viewColumn });
            }

            // Anchor Search Correction
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

                // Trigger animation
                performFlashAnimation(targetEditor, range);
            }
        })
    );

    // 4. snaptex.internal.syncScroll (Preview Scroll -> Editor)
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.internal.syncScroll', (index: number, ratio: number) => {
            const config = vscode.workspace.getConfiguration('snaptex');
            const enableSync = config.get<boolean>('autoScrollSync', true);
            if (!enableSync) { return; }

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
    // Event Listeners
    // =========================================================

    // Listener 1: Cursor Move (Cursor -> Preview)
    let cursorDebounceTimer: NodeJS.Timeout | undefined;

    vscode.window.onDidChangeTextEditorSelection(e => {
        const editor = e.textEditor;
        if (editor !== vscode.window.activeTextEditor) { return; }

        // [Logic] Lock ratio if scrolling (Gaze Locking)
        if (isEditorScrolling) { return; }

        const cursorLine = e.selections[0].active.line;
        const cursorChar = e.selections[0].active.character;
        const visibleRange = editor.visibleRanges[0];

        // Update ratio only when user explicitly moves cursor
        if (visibleRange) {
            if (visibleRange.contains(e.selections[0].active)) {
                const totalVisibleLines = visibleRange.end.line - visibleRange.start.line;
                if (totalVisibleLines > 0) {
                    const ratio = (cursorLine - visibleRange.start.line) / totalVisibleLines;
                    activeCursorScreenRatio = Math.max(0.1, Math.min(0.9, ratio));
                }
            }
        }

        if (!TexPreviewPanel.currentPanel) { return; }
        if (isSyncingFromPreview) { return; }

        const config = vscode.workspace.getConfiguration('snaptex');
        const enableSync = config.get<boolean>('autoScrollSync', true);
        const delay = config.get<number>('autoScrollDelay', 200);

        if (!enableSync) { return; }

        if (cursorDebounceTimer) { clearTimeout(cursorDebounceTimer); }
        cursorDebounceTimer = setTimeout(() => {
            triggerSyncToPreview(editor, cursorLine, true, activeCursorScreenRatio, cursorChar);
        }, delay);
    }, null, context.subscriptions);


    // Listener 2: Scroll (Editor Scroll -> Preview)
    let throttleTimer: NodeJS.Timeout | undefined;

    vscode.window.onDidChangeTextEditorVisibleRanges(e => {
        const editor = e.textEditor;
        if (editor !== vscode.window.activeTextEditor) { return; }
        if (!TexPreviewPanel.currentPanel) { return; }
        if (isSyncingFromPreview) { return; }

        const config = vscode.workspace.getConfiguration('snaptex');
        const enableSync = config.get<boolean>('autoScrollSync', true);
        const delay = config.get<number>('autoScrollDelay', 100);

        if (!enableSync) { return; }

        // Mark as scrolling
        isEditorScrolling = true;
        if (scrollEndTimer) { clearTimeout(scrollEndTimer); }
        scrollEndTimer = setTimeout(() => {
            isEditorScrolling = false;
        }, 200);

        if (throttleTimer) { return; }
        throttleTimer = setTimeout(() => {
            throttleTimer = undefined;
            if (e.visibleRanges.length > 0) {
                const range = e.visibleRanges[0];
                const visibleHeight = range.end.line - range.start.line;
                // [Logic] Use locked ratio for smooth scrolling
                const targetLine = Math.floor(range.start.line + (visibleHeight * activeCursorScreenRatio));
                triggerSyncToPreview(editor, targetLine, true, activeCursorScreenRatio);
            }
        }, delay);
    }, null, context.subscriptions);


    // Listener 3: Save -> Update
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(doc => {
            const editor = vscode.window.activeTextEditor;
            if (editor && doc === editor.document) {
                updatePreview(false);
            }
        })
    );

    // Listener 4: Live Update
    let updateDebounceTimer: NodeJS.Timeout | undefined;
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            const editor = vscode.window.activeTextEditor;
            if (editor && e.document === editor.document) {
                const config = vscode.workspace.getConfiguration('snaptex');
                const enableLivePreview = config.get<boolean>('livePreview', true);
                const debounceDelay = config.get<number>('delay', 200);

                if (enableLivePreview) {
                    if (updateDebounceTimer) { clearTimeout(updateDebounceTimer); }
                    updateDebounceTimer = setTimeout(() => {
                        updatePreview(false);
                    }, debounceDelay);
                }
            }
        })
    );

    // Listener 5: Switch Tab
    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            const config = vscode.workspace.getConfiguration('snaptex');
            const renderOnSwitch = config.get<boolean>('renderOnSwitch', true);
            if (renderOnSwitch) {
                updatePreview(true);
            }
        }
    }, null, context.subscriptions);
}

export function deactivate() {
    console.log('[SnapTeX] Deactivated.');
}