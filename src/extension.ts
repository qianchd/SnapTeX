import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { SmartRenderer } from './renderer';
import { TexPreviewPanel } from './panel';

// =========================================================
// 1. Decoration Types for Flash Animation
//    (Visual feedback when jumping to a line)
// =========================================================

// High intensity (starting point)
const flashDecorationTypeHigh = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
    isWholeLine: true,
});
// Fading out steps...
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
// When true, we ignore scroll events from the editor to avoid echo.
let isSyncingFromPreview = false;
let syncLockTimer: NodeJS.Timeout | undefined;

// Tracks which document URI is currently rendered in the preview.
// Used to ensure we don't sync scroll for an unrelated active editor.
let currentRenderedUri: vscode.Uri | undefined = undefined;

// Cache for the cursor's relative position on screen (0.0 to 1.0).
// Used to maintain the user's visual context (e.g., keeping cursor at top vs center).
let activeCursorScreenRatio: number = 0.5;

// Subscription for panel events (used for the "Initial Jump" on load).
let panelLoadSubscription: vscode.Disposable | undefined;

/**
 * Helper to debounce function calls (e.g., scroll events).
 */
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

/**
 * Determines the current workspace root directory.
 * Used for loading local configuration files (snaptex.config.js).
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
 * Extracts a "context snippet" (Anchor) around the target line.
 * This string is sent to the Webview to help fuzzy-match the correct location
 * if the exact line number mapping is slightly off (e.g., due to macros).
 */
function getAnchorContext(doc: vscode.TextDocument, line: number, char?: number): string {
    if (line < 0 || line >= doc.lineCount) { return ""; }

    const lineObj = doc.lineAt(line);
    const lineText = lineObj.text;
    let rawSnippet = "";

    // Strategy A: Character-based anchor (Precise cursor sync)
    if (char !== undefined && char >= 0) {
        const start = Math.max(0, char - 20);
        const end = Math.min(lineText.length, char + 30);
        rawSnippet = lineText.substring(start, end);
    } else {
        // Strategy B: Line-based anchor (General scroll sync)
        rawSnippet = lineText.substring(0, 60);
    }

    // Clean up LaTeX syntax to make the anchor more robust
    let clean = rawSnippet
        .replace(/\\[a-zA-Z]+\*?\{?/g, ' ') // Remove commands like \section{
        .replace(/[{}$%]/g, ' ')          // Remove special chars
        .replace(/\s+/g, ' ')             // Normalize whitespace
        .trim();

    // Fallback if the snippet is too short
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

/**
 * Executes a visual "Flash" animation on the editor to highlight a specific range.
 */
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

    // Cleanup
    const lastStep = flashSequence[flashSequence.length - 1];
    editor.setDecorations(lastStep.decoration, []);
}

// =========================================================
// 4. Extension Activation (Entry Point)
// =========================================================

export function activate(context: vscode.ExtensionContext) {
    console.log('[SnapTeX] Activated!');

    // Initialize the Renderer Service
    // Note: The renderer holds the state of the document and rules.
    const renderer = new SmartRenderer();
    renderer.reloadAllRules(getProjectRoot());

    // Watch for configuration changes (snaptex.config.js)
    const configWatcher = vscode.workspace.createFileSystemWatcher('**/snaptex.config.js');
    configWatcher.onDidChange(() => {
        renderer.reloadAllRules(getProjectRoot());
        // Trigger a re-render if the panel is active
        TexPreviewPanel.currentPanel?.update();
    });
    context.subscriptions.push(configWatcher);

    // -------------------------------------------------------------------------
    // Core Logic: Sync Editor -> Preview
    // -------------------------------------------------------------------------
    const triggerSyncToPreview = (
        editor: vscode.TextEditor,
        targetLine: number,
        isAutoScroll: boolean = false,
        viewRatio: number = 0.5,
        targetChar?: number
    ) => {
        if (!TexPreviewPanel.currentPanel) { return; }

        // Ensure we are syncing the correct document
        if (currentRenderedUri && editor.document.uri.toString() !== currentRenderedUri.toString()) {
            return;
        }

        const filePath = editor.document.uri.fsPath;

        // Use the proxy method on Renderer to map physical line -> flattened block
        // (This utilizes the underlying LatexDocument model)
        const flatLine = renderer.getFlattenedLine(filePath, targetLine);

        if (flatLine === -1) { return; }

        // Get block index and internal ratio
        const { index, ratio } = renderer.getBlockIndexByLine(flatLine);
        const anchor = getAnchorContext(editor.document, targetLine, targetChar);

        // Send command to Webview
        TexPreviewPanel.currentPanel.postMessage({
            command: 'scrollToBlock',
            index: index,
            ratio: ratio,
            anchor: anchor,
            auto: isAutoScroll, // 'true' prevents visual highlighting in Webview
            viewRatio: viewRatio
        });
    };

    // -------------------------------------------------------------------------
    // Core Logic: Initial Jump on Load
    // -------------------------------------------------------------------------
    const hookPanelEvents = (panel: TexPreviewPanel) => {
        if (panelLoadSubscription) { panelLoadSubscription.dispose(); }

        // When the Webview DOM is ready...
        panelLoadSubscription = panel.onWebviewLoaded(() => {
            const editor = vscode.window.activeTextEditor;
            // Verify context match
            if (editor && currentRenderedUri && editor.document.uri.toString() === currentRenderedUri.toString()) {
                // Immediately sync to the current cursor position
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

    // -------------------------------------------------------------------------
    // Core Logic: Trigger Preview Update
    // -------------------------------------------------------------------------
    const updatePreview = (force: boolean = false) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !TexPreviewPanel.currentPanel) { return; }

        // Only update if it's the same document or forced (e.g., tab switch)
        if (!force && currentRenderedUri && editor.document.uri.toString() !== currentRenderedUri.toString()) {
            return;
        }
        currentRenderedUri = editor.document.uri;

        // Reload rules in case project root changed
        renderer.reloadAllRules(getProjectRoot());
        // Delegate rendering to the Panel (which uses LatexDocument)
        TexPreviewPanel.currentPanel.update();
    };


    // =========================================================
    // 5. Command Registration
    // =========================================================

    // Command: Start / Open Preview
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

    // Command: Manual Sync (Ctrl+Alt+N)
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.syncToPreview', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                // Manual sync treats isAutoScroll as false (triggers highlight)
                triggerSyncToPreview(
                    editor,
                    editor.selection.active.line,
                    false,
                    activeCursorScreenRatio,
                    editor.selection.active.character
                );
            }
        })
    );

    // Command: Reverse Sync (Preview Click -> Editor Jump)
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.internal.revealLine', async (uri: vscode.Uri, index: number, ratio: number, anchor: string) => {
            // Set lock to prevent echo
            isSyncingFromPreview = true;
            if (syncLockTimer) { clearTimeout(syncLockTimer); }
            syncLockTimer = setTimeout(() => { isSyncingFromPreview = false; }, 500);

            // 1. Map Block -> Source Location (Using Renderer Proxy)
            const flatLine = renderer.getLineByBlockIndex(index, ratio);
            const originalLoc = renderer.getOriginalPosition(flatLine);
            if (!originalLoc) { return; }

            const targetUri = vscode.Uri.file(originalLoc.file);
            let targetLine = originalLoc.line;

            // 2. Open or Focus Editor
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

            // 3. Anchor Correction (Fuzzy matching if line is slightly off)
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

            // 4. Reveal and Animate
            if (targetEditor) {
                const safeLine = Math.max(0, Math.min(targetLine, targetEditor.document.lineCount - 1));
                const lineObj = targetEditor.document.lineAt(safeLine);
                const range = lineObj.range;

                targetEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                targetEditor.selection = new vscode.Selection(range.start, range.start);

                // Trigger Flash Animation
                performFlashAnimation(targetEditor, range);
            }
        })
    );

    // Command: Internal Sync Scroll (Preview Scroll -> Editor Scroll)
    // Pure scrolling, no animation.
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.internal.syncScroll', (index: number, ratio: number) => {
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
    // 6. Event Listeners
    // =========================================================

    // Listener: Cursor Move (Cursor -> Preview)
    // Calculates screen ratio to keep visual context synced.
    let cursorDebounceTimer: NodeJS.Timeout | undefined;

    vscode.window.onDidChangeTextEditorSelection(e => {
        const editor = e.textEditor;
        if (editor !== vscode.window.activeTextEditor) { return; }

        const cursorLine = e.selections[0].active.line;
        const cursorChar = e.selections[0].active.character;
        const visibleRange = editor.visibleRanges[0];

        // Calculate active cursor ratio (0.0 - 1.0 relative to viewport)
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

        if (!TexPreviewPanel.currentPanel) { return; }
        if (isSyncingFromPreview) { return; }

        const config = vscode.workspace.getConfiguration('snaptex');
        const enableSync = config.get<boolean>('autoScrollSync', true);
        const delay = config.get<number>('autoScrollDelay', 200);

        if (!enableSync) { return; }

        if (cursorDebounceTimer) { clearTimeout(cursorDebounceTimer); }
        cursorDebounceTimer = setTimeout(() => {
            // isAutoScroll=true (No highlight)
            triggerSyncToPreview(editor, cursorLine, true, activeCursorScreenRatio, cursorChar);
        }, delay);
    }, null, context.subscriptions);


    // Listener: Scroll (Editor Scroll -> Preview)
    let throttleTimer: NodeJS.Timeout | undefined;

    vscode.window.onDidChangeTextEditorVisibleRanges(e => {
        const editor = e.textEditor;
        if (editor !== vscode.window.activeTextEditor) { return; }
        if (!TexPreviewPanel.currentPanel) { return; }
        if (isSyncingFromPreview) { return; }

        const config = vscode.workspace.getConfiguration('snaptex');
        const enableSync = config.get<boolean>('autoScrollSync', true);
        const delay = config.get<number>('autoScrollDelay', 200);

        if (!enableSync) { return; }

        if (throttleTimer) { return; }
        throttleTimer = setTimeout(() => {
            throttleTimer = undefined;
            if (e.visibleRanges.length > 0) {
                const range = e.visibleRanges[0];
                const visibleHeight = range.end.line - range.start.line;
                // Calculate target line based on previous cursor ratio
                const targetLine = Math.floor(range.start.line + (visibleHeight * activeCursorScreenRatio));
                triggerSyncToPreview(editor, targetLine, true, activeCursorScreenRatio);
            }
        }, delay);
    }, null, context.subscriptions);


    // Listener: Document Save
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(doc => {
            const editor = vscode.window.activeTextEditor;
            if (editor && doc === editor.document) {
                updatePreview(false);
            }
        })
    );

    // Listener: Document Edit (Live Preview)
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

    // Listener: Switch Active Tab
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