import * as vscode from 'vscode';
import { SmartRenderer } from './renderer';
import { TexPreviewPanel } from './panel';
import { VscodeFileProvider } from './file-provider';
import { normalizeUri } from './utils';

// --- Flash Animation Decoration Types ---
const flashDecorationTypeHigh = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'), isWholeLine: true });
const flashDecorationType80 = vscode.window.createTextEditorDecorationType({ backgroundColor: 'color-mix(in srgb, var(--vscode-editor-wordHighlightBackground) 80%, transparent)', isWholeLine: true });
const flashDecorationType60 = vscode.window.createTextEditorDecorationType({ backgroundColor: 'color-mix(in srgb, var(--vscode-editor-wordHighlightBackground) 60%, transparent)', isWholeLine: true });
const flashDecorationType40 = vscode.window.createTextEditorDecorationType({ backgroundColor: 'color-mix(in srgb, var(--vscode-editor-wordHighlightBackground) 40%, transparent)', isWholeLine: true });
const flashDecorationType10 = vscode.window.createTextEditorDecorationType({ backgroundColor: 'color-mix(in srgb, var(--vscode-editor-wordHighlightBackground) 10%, transparent)', isWholeLine: true });

// --- Global State ---
let isSyncingFromPreview = false;
let syncLockTimer: NodeJS.Timeout | undefined;
let isEditorScrolling = false;
let scrollEndTimer: NodeJS.Timeout | undefined;
let currentRenderedUri: vscode.Uri | undefined = undefined;
let activeCursorScreenRatio: number = 0.5;

// --- Helpers ---
const debounce = (func: Function, waitGetter: () => number) => {
    let timeout: NodeJS.Timeout | undefined;
    return (...args: any[]) => {
        if (timeout) { clearTimeout(timeout); }
        timeout = setTimeout(() => func(...args), waitGetter());
    };
};

function getAnchorContext(doc: vscode.TextDocument, line: number, char?: number): string {
    if (line < 0 || line >= doc.lineCount) {return "";}
    const lineText = doc.lineAt(line).text;
    let rawSnippet = (char !== undefined && char >= 0)
        ? lineText.substring(Math.max(0, char - 20), Math.min(lineText.length, char + 30))
        : lineText.substring(0, 60);

    let clean = rawSnippet.replace(/\\[a-zA-Z]+\*?\{?/g, ' ').replace(/[{}$%]/g, ' ').replace(/\s+/g, ' ').trim();
    return clean.length >= 5 ? clean.substring(0, 40) : "";
}

async function performFlashAnimation(editor: vscode.TextEditor, range: vscode.Range) {
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const seq = [
        { d: flashDecorationTypeHigh, t: 300 }, { d: flashDecorationType80, t: 40 },
        { d: flashDecorationType60, t: 40 }, { d: flashDecorationType40, t: 150 },
        { d: flashDecorationType10, t: 240 }
    ];
    for (let i = 0; i < seq.length; i++) {
        const step = seq[i];
        editor.setDecorations(step.d, [range]);
        if (i > 0) {editor.setDecorations(seq[i-1].d, []);}
        await sleep(step.t);
    }
    editor.setDecorations(seq[seq.length-1].d, []);
}

/**
 * [CRITICAL FIX] Robust URI comparison using normalizeUri
 * This handles 'file://' prefix differences and encoding differences uniformly.
 */
function areUrisEqual(uri1: vscode.Uri, uri2: vscode.Uri): boolean {
    return normalizeUri(uri1) === normalizeUri(uri2);
}

export function activate(context: vscode.ExtensionContext) {
    console.log('[SnapTeX] Activated!');

    const fileProvider = new VscodeFileProvider();
    const renderer = new SmartRenderer(fileProvider);

    renderer.reloadAllRules();

    // --- Core Sync Logic (Forward: Tex -> Preview) ---
    const triggerSyncToPreview = (editor: vscode.TextEditor, targetLine: number, isAutoScroll: boolean, viewRatio: number, targetChar?: number) => {
        if (!TexPreviewPanel.currentPanel) {return;}
        // if (currentRenderedUri && !areUrisEqual(editor.document.uri, currentRenderedUri)) { return; }

        // [DEBUG] Forward Sync
        // console.log(`[SnapTeX Forward] Triggered for: ${editor.document.uri.toString()} line ${targetLine}`);

        const syncData = renderer.getPreviewSyncData(editor.document.uri.toString(), targetLine);
        if (!syncData) {
            console.log(`[SnapTeX] Sync failed: No map found for ${editor.document.uri.toString()}`);
            return;
        }

        const { index, ratio } = syncData;
        const anchor = getAnchorContext(editor.document, targetLine, targetChar);

        TexPreviewPanel.currentPanel.postMessage({
            command: 'scrollToBlock', index, ratio, anchor, auto: isAutoScroll, viewRatio
        });
    };

    const updatePreview = (force: boolean = false) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !TexPreviewPanel.currentPanel) {return;}
        if (!force && currentRenderedUri && !areUrisEqual(editor.document.uri, currentRenderedUri)) {return;}

        currentRenderedUri = editor.document.uri;
        renderer.reloadAllRules();
        TexPreviewPanel.currentPanel.update();
    };

    const debouncedUpdatePreview = debounce(
        (force: boolean) => updatePreview(force),
        () => vscode.workspace.getConfiguration('snaptex').get<number>('delay', 200)
    );

    // --- Commands ---

    context.subscriptions.push(vscode.commands.registerCommand('snaptex.start', () => {
        if (TexPreviewPanel.currentPanel) { updatePreview(true); }
        else {
            TexPreviewPanel.createOrShow(context.extensionUri, renderer);
            if (vscode.window.activeTextEditor) { currentRenderedUri = vscode.window.activeTextEditor.document.uri; }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('snaptex.toggleAutoScroll', async () => {
        const config = vscode.workspace.getConfiguration('snaptex');
        const currentValue = config.get<boolean>('autoScrollSync', true);

        // Update setting globally (User Settings)
        await config.update('autoScrollSync', !currentValue, vscode.ConfigurationTarget.Global);

        const status = !currentValue ? 'Enabled' : 'Disabled';
        vscode.window.setStatusBarMessage(`SnapTeX Auto Scroll: ${status}`, 3000);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('snaptex.syncToPreview', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) { triggerSyncToPreview(editor, editor.selection.active.line, false, activeCursorScreenRatio, editor.selection.active.character); }
    }));

    // Command: Reveal Line (Reverse: Preview -> Editor)
    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.internal.revealLine', async (uri: vscode.Uri, index: number, ratio: number, anchor: string, viewRatio: number = 0.5) => {
            isSyncingFromPreview = true;
            if (syncLockTimer) { clearTimeout(syncLockTimer); }
            syncLockTimer = setTimeout(() => { isSyncingFromPreview = false; }, 500);

            // 1. Get Source Location
            const sourceLoc = renderer.getSourceSyncData(index, ratio);
            if (!sourceLoc) {return;}

            // [DEBUG] Reverse Sync
            // console.log(`[SnapTeX Reverse] Target: ${sourceLoc.file} Line: ${sourceLoc.line}`);

            // [FIX] Use parse + normalize for lookup
            const targetUri = vscode.Uri.parse(sourceLoc.file);
            let targetLine = sourceLoc.line;

            // Robust search for visible editors
            let targetEditor = vscode.window.visibleTextEditors.find(e => areUrisEqual(e.document.uri, targetUri));

            if (!targetEditor) {
                try {
                    const doc = await vscode.workspace.openTextDocument(targetUri);
                    targetEditor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
                } catch (e) {
                    console.error(`[SnapTeX Reverse] Failed to open: ${targetUri.toString()}`, e);
                    return;
                }
            } else {
                await vscode.window.showTextDocument(targetEditor.document, { viewColumn: targetEditor.viewColumn });
            }

            // Anchor refinement logic
            if (anchor && anchor.length > 3) {
                const range = new vscode.Range(Math.max(0, targetLine - 5), 0, Math.min(targetEditor.document.lineCount, targetLine + 10), 0);
                const text = targetEditor.document.getText(range);
                const idx = text.indexOf(anchor);
                if (idx !== -1) {
                    targetLine = Math.max(0, targetLine - 5) + text.substring(0, idx).split('\n').length - 1;
                }
            }

            // Calculate reveal range
            const range = targetEditor.document.lineAt(Math.max(0, Math.min(targetLine, targetEditor.document.lineCount - 1))).range;

            // Smart Relative Sync
            const visible = targetEditor.visibleRanges[0];
            if (visible) {
                const height = visible.end.line - visible.start.line;
                const startLine = Math.max(0, Math.floor(targetLine - height * viewRatio));
                targetEditor.revealRange(new vscode.Range(startLine, 0, startLine, 0), vscode.TextEditorRevealType.AtTop);
            } else {
                // Fallback
                targetEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            }

            targetEditor.selection = new vscode.Selection(range.start, range.start);
            performFlashAnimation(targetEditor, range);
        })
    );

    context.subscriptions.push(vscode.commands.registerCommand('snaptex.internal.syncScroll', (index: number, ratio: number) => {
        const currentConfig = vscode.workspace.getConfiguration('snaptex');
        if (!currentConfig.get<boolean>('autoScrollSync', true)) { return; }

        isSyncingFromPreview = true;
        if (syncLockTimer) {clearTimeout(syncLockTimer);}
        syncLockTimer = setTimeout(() => { isSyncingFromPreview = false; }, 500);

        const sourceLoc = renderer.getSourceSyncData(index, ratio);
        if (!sourceLoc) {return;}

        const targetUri = vscode.Uri.parse(sourceLoc.file);

        // [FIX] Use robust areUrisEqual
        const editor = vscode.window.visibleTextEditors.find(e => areUrisEqual(e.document.uri, targetUri));

        if (editor) {
            const line = Math.max(0, Math.min(sourceLoc.line, editor.document.lineCount - 1));
            editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
        }
    }));

    // --- Listeners ---
    vscode.window.onDidChangeTextEditorSelection(e => {
        if (e.textEditor !== vscode.window.activeTextEditor || isEditorScrolling) {return;}

        const sel = e.selections[0].active;
        const visible = e.textEditor.visibleRanges[0];
        if (visible && visible.contains(sel)) {
            activeCursorScreenRatio = (sel.line - visible.start.line) / (visible.end.line - visible.start.line);
            activeCursorScreenRatio = Math.max(0.1, Math.min(0.9, activeCursorScreenRatio));
        }

        if (!TexPreviewPanel.currentPanel || isSyncingFromPreview) { return; }
        const currentConfig = vscode.workspace.getConfiguration('snaptex');
        if (!currentConfig.get<boolean>('autoScrollSync', true)) { return; }

        // Use a simpler debounce here (inline is fine for simple scroll events, but could be optimized similarly)
        setTimeout(() => triggerSyncToPreview(e.textEditor, sel.line, true, activeCursorScreenRatio, sel.character), 200);
    });

    vscode.window.onDidChangeTextEditorVisibleRanges(e => {
        if (e.textEditor !== vscode.window.activeTextEditor || !TexPreviewPanel.currentPanel || isSyncingFromPreview) { return; }
        const currentConfig = vscode.workspace.getConfiguration('snaptex');
        if (!currentConfig.get<boolean>('autoScrollSync', true)) { return; }

        isEditorScrolling = true;
        if (scrollEndTimer) {clearTimeout(scrollEndTimer);}
        scrollEndTimer = setTimeout(() => { isEditorScrolling = false; }, 200);

        // Throttle
        setTimeout(() => {
            if (e.visibleRanges.length > 0) {
                const range = e.visibleRanges[0];
                const targetLine = Math.floor(range.start.line + ((range.end.line - range.start.line) * activeCursorScreenRatio));
                triggerSyncToPreview(e.textEditor, targetLine, true, activeCursorScreenRatio);
            }
        }, 100);
    });

    vscode.workspace.onDidSaveTextDocument(doc => {
        if (vscode.window.activeTextEditor && doc === vscode.window.activeTextEditor.document) {updatePreview(false);}
    });

    vscode.workspace.onDidChangeTextDocument(e => {
        if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
            const currentConfig = vscode.workspace.getConfiguration('snaptex');
            if (currentConfig.get<boolean>('livePreview', true)) {
                debouncedUpdatePreview(false);
            }
        }
    });

    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && vscode.workspace.getConfiguration('snaptex').get<boolean>('renderOnSwitch', true)) {updatePreview(true);}
    });

    // Webview Serializer
    if (vscode.window.registerWebviewPanelSerializer) {
        vscode.window.registerWebviewPanelSerializer(TexPreviewPanel.viewType, {
            async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, _state: any) {
                TexPreviewPanel.revive(webviewPanel, context.extensionUri, renderer);
            }
        });
    }
}

export function deactivate() { }