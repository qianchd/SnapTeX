import * as vscode from 'vscode';
import { SmartRenderer } from '../../../src/renderer';
import { TexPreviewPanel } from './panel';
import { getSyncAnchorContext, normalizeUri } from '../../../src/utils';
import { ExtensionToWebviewCommand } from '../../../src/webview-messages';
import { PreviewUpdateService } from '../../../src/preview-update-service';
import { VscodeFileProvider } from './vscode-file-provider';

const createFlashDecoration = (backgroundColor: string | vscode.ThemeColor) => vscode.window.createTextEditorDecorationType({ backgroundColor, isWholeLine: true });
const flashColor = (opacity: number) => `color-mix(in srgb, var(--vscode-editor-wordHighlightBackground) ${opacity}%, transparent)`;
const FLASH_ANIMATION_STEPS = [
    { backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'), duration: 300 },
    { backgroundColor: flashColor(80), duration: 40 },
    { backgroundColor: flashColor(60), duration: 40 },
    { backgroundColor: flashColor(40), duration: 150 },
    { backgroundColor: flashColor(10), duration: 240 }
].map(step => ({ decoration: createFlashDecoration(step.backgroundColor), duration: step.duration }));

let isEditorScrolling = false;
let scrollEndTimer: NodeJS.Timeout | undefined;
let autoSyncTimer: NodeJS.Timeout | undefined;
let currentRenderedUri: vscode.Uri | undefined;
let activeCursorScreenRatio: number = 0.5;
let suppressTextToPreviewUntil = 0;
let suppressPreviewToTextUntil = 0;

const isAutoScrollSyncEnabled = () => vscode.workspace.getConfiguration('snaptex').get<boolean>('autoScrollSync', true);

const debounce = <Args extends unknown[]>(func: (...args: Args) => void, waitGetter: () => number) => {
    let timeout: NodeJS.Timeout | undefined;
    return (...args: Args) => {
        if (timeout) { clearTimeout(timeout); }
        timeout = setTimeout(() => func(...args), waitGetter());
    };
};

const getAutoScrollDelay = () => Math.max(0, vscode.workspace.getConfiguration('snaptex').get<number>('autoScrollDelay', 100));

function getSyncSuppressionDuration() {
    return Math.max(500, getAutoScrollDelay() + 300);
}

function getAnchorContext(doc: vscode.TextDocument, line: number, char?: number): string {
    if (line < 0 || line >= doc.lineCount) {return "";}
    return getSyncAnchorContext(doc.lineAt(line).text, char);
}

function findNearestAnchorLine(document: vscode.TextDocument, anchors: string[], startLine: number, endLine: number, estimatedLine: number): number | undefined {
    for (const anchor of new Set(anchors)) {
        const normalizedAnchor = anchor.replace(/\s+/g, ' ').trim();
        if (normalizedAnchor.length <= 3) { continue; }
        let closestLine: number | undefined;
        for (let line = startLine; line <= endLine; line++) {
            if (!document.lineAt(line).text.replace(/\s+/g, ' ').includes(normalizedAnchor)) { continue; }
            if (closestLine === undefined || Math.abs(line - estimatedLine) < Math.abs(closestLine - estimatedLine)) {
                closestLine = line;
            }
        }
        if (closestLine !== undefined) { return closestLine; }
    }
    return undefined;
}

async function performFlashAnimation(editor: vscode.TextEditor, range: vscode.Range) {
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < FLASH_ANIMATION_STEPS.length; i++) {
        const step = FLASH_ANIMATION_STEPS[i];
        editor.setDecorations(step.decoration, [range]);
        if (i > 0) {editor.setDecorations(FLASH_ANIMATION_STEPS[i - 1].decoration, []);}
        await sleep(step.duration);
    }
    editor.setDecorations(FLASH_ANIMATION_STEPS[FLASH_ANIMATION_STEPS.length - 1].decoration, []);
}

/**
 * Compares URIs through the same normalized form used by the document mapper.
 */
function areUrisEqual(uri1: vscode.Uri, uri2: vscode.Uri): boolean {
    return normalizeUri(uri1) === normalizeUri(uri2);
}

/**
 * VS Code extension entry point.
 *
 * The extension owns command registration, editor-preview synchronization, and
 * preview panel lifecycle. Rendering and parsing are delegated to SmartRenderer
 * and TexPreviewPanel so this file stays focused on VS Code events.
 */
export function activate(context: vscode.ExtensionContext) {
    const renderer = new SmartRenderer();
    const fileProvider = new VscodeFileProvider();
    const updateService = new PreviewUpdateService(fileProvider, renderer);

    const triggerSyncToPreview = (editor: vscode.TextEditor, targetLine: number, isAutoScroll: boolean, viewRatio: number, targetChar?: number) => {
        if (!TexPreviewPanel.currentPanel) {return;}

        const syncData = renderer.getPreviewSyncData(editor.document.uri.toString(), targetLine);
        if (!syncData) {
            console.log(`[SnapTeX] Sync failed: No map found for ${editor.document.uri.toString()}`);
            return;
        }

        const { index, ratio } = syncData;
        const anchor = getAnchorContext(editor.document, targetLine, targetChar);

        suppressPreviewToTextUntil = Date.now() + getSyncSuppressionDuration();
        TexPreviewPanel.currentPanel.postMessage({
            command: ExtensionToWebviewCommand.ScrollToBlock, index, ratio, anchor, auto: isAutoScroll, viewRatio
        });
    };

    const clearPendingAutoSync = () => {
        if (autoSyncTimer) { clearTimeout(autoSyncTimer); }
        autoSyncTimer = undefined;
    };

    const scheduleAutoSyncToPreview = (
        editor: vscode.TextEditor,
        targetLine: number,
        viewRatio: number,
        targetChar?: number
    ) => {
        clearPendingAutoSync();
        autoSyncTimer = setTimeout(() => {
            autoSyncTimer = undefined;
            triggerSyncToPreview(editor, targetLine, true, viewRatio, targetChar);
        }, getAutoScrollDelay());
    };

    /**
     * Updates the preview target according to the active editor, subfile mapping,
     * and the renderOnSwitch policy.
     */
    const updatePreview = (force: boolean = false) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !TexPreviewPanel.currentPanel) {return;}

        const activeUri = editor.document.uri;
        let targetRoot = activeUri;

        const config = vscode.workspace.getConfiguration('snaptex');
        const renderOnSwitch = config.get<boolean>('renderOnSwitch', false);

        if (currentRenderedUri) {
            if (areUrisEqual(activeUri, currentRenderedUri)) {
                targetRoot = currentRenderedUri;
            } else if (renderer.isKnownFile(activeUri.toString())) {
                targetRoot = currentRenderedUri;
            } else {
                if (!renderOnSwitch && !force) {
                    return;
                }

                targetRoot = activeUri;
            }
        }

        currentRenderedUri = targetRoot;

        TexPreviewPanel.currentPanel.update(targetRoot);
    };

    const debouncedUpdatePreview = debounce(
        (force: boolean) => updatePreview(force),
        () => vscode.workspace.getConfiguration('snaptex').get<number>('delay', 200)
    );

    context.subscriptions.push(vscode.commands.registerCommand('snaptex.start', () => {
        if (TexPreviewPanel.currentPanel) {
            updatePreview(true);
        }
        else {
            const editor = vscode.window.activeTextEditor;
            const panel = TexPreviewPanel.createOrShow(context.extensionUri, fileProvider, updateService);
            if (editor) {
                currentRenderedUri = editor.document.uri;
                void panel.update(editor.document.uri);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('snaptex.toggleAutoScroll', async () => {
        const config = vscode.workspace.getConfiguration('snaptex');
        const currentValue = config.get<boolean>('autoScrollSync', true);

        await config.update('autoScrollSync', !currentValue, vscode.ConfigurationTarget.Global);

        const status = !currentValue ? 'Enabled' : 'Disabled';
        vscode.window.setStatusBarMessage(`SnapTeX Auto Scroll: ${status}`, 3000);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('snaptex.syncToPreview', () => {
        const editor = vscode.window.activeTextEditor;
        clearPendingAutoSync();
        if (editor) { triggerSyncToPreview(editor, editor.selection.active.line, false, activeCursorScreenRatio, editor.selection.active.character); }
    }));

    context.subscriptions.push(
        vscode.commands.registerCommand('snaptex.internal.revealLine', async (_uri: vscode.Uri, index: number, ratio: number, anchors: string[] = [], viewRatio: number = 0.5) => {
            suppressTextToPreviewUntil = Date.now() + getSyncSuppressionDuration();

            const sourceLoc = renderer.getSourceSyncData(index, ratio);
            if (!sourceLoc) {return;}

            const targetUri = vscode.Uri.parse(sourceLoc.file);
            let targetLine = sourceLoc.line;

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

            if (anchors.length > 0) {
                const startLine = Math.max(0, sourceLoc.blockRange?.startLine ?? targetLine - 5);
                const endLine = Math.min(targetEditor.document.lineCount - 1, sourceLoc.blockRange?.endLine ?? targetLine + 10);
                targetLine = findNearestAnchorLine(targetEditor.document, anchors, startLine, endLine, targetLine) ?? targetLine;
            }

            const range = targetEditor.document.lineAt(Math.max(0, Math.min(targetLine, targetEditor.document.lineCount - 1))).range;

            const visible = targetEditor.visibleRanges[0];
            if (visible) {
                const height = visible.end.line - visible.start.line;
                const startLine = Math.max(0, Math.floor(targetLine - height * viewRatio));
                targetEditor.revealRange(new vscode.Range(startLine, 0, startLine, 0), vscode.TextEditorRevealType.AtTop);
            } else {
                targetEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            }

            targetEditor.selection = new vscode.Selection(range.start, range.start);
            performFlashAnimation(targetEditor, range);
        })
    );

    context.subscriptions.push(vscode.commands.registerCommand('snaptex.internal.syncScroll', (index: number, ratio: number) => {
        if (!isAutoScrollSyncEnabled()) { return; }
        if (Date.now() < suppressPreviewToTextUntil) { return; }

        suppressTextToPreviewUntil = Date.now() + getSyncSuppressionDuration();

        const sourceLoc = renderer.getSourceSyncData(index, ratio);
        if (!sourceLoc) {return;}

        const targetUri = vscode.Uri.parse(sourceLoc.file);

        const editor = vscode.window.visibleTextEditors.find(e => areUrisEqual(e.document.uri, targetUri));

        if (editor) {
            const line = Math.max(0, Math.min(sourceLoc.line, editor.document.lineCount - 1));
            editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
        }
    }));

    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(e => {
        if (e.textEditor !== vscode.window.activeTextEditor || isEditorScrolling) {return;}

        const sel = e.selections[0].active;
        const visible = e.textEditor.visibleRanges[0];
        if (visible && visible.contains(sel)) {
            activeCursorScreenRatio = (sel.line - visible.start.line) / (visible.end.line - visible.start.line);
            activeCursorScreenRatio = Math.max(0.1, Math.min(0.9, activeCursorScreenRatio));
        }

        if (!TexPreviewPanel.currentPanel || Date.now() < suppressTextToPreviewUntil) { return; }
        if (!isAutoScrollSyncEnabled()) { return; }

        scheduleAutoSyncToPreview(e.textEditor, sel.line, activeCursorScreenRatio, sel.character);
    }));

    context.subscriptions.push(vscode.window.onDidChangeTextEditorVisibleRanges(e => {
        if (e.textEditor !== vscode.window.activeTextEditor || !TexPreviewPanel.currentPanel || Date.now() < suppressTextToPreviewUntil) { return; }
        if (!isAutoScrollSyncEnabled()) { return; }

        isEditorScrolling = true;
        if (scrollEndTimer) {clearTimeout(scrollEndTimer);}
        scrollEndTimer = setTimeout(() => { isEditorScrolling = false; }, getAutoScrollDelay());

        if (e.visibleRanges.length > 0) {
            const range = e.visibleRanges[0];
            const targetLine = Math.floor(range.start.line + ((range.end.line - range.start.line) * activeCursorScreenRatio));
            scheduleAutoSyncToPreview(e.textEditor, targetLine, activeCursorScreenRatio);
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => {
        if (vscode.window.activeTextEditor) {updatePreview(false);}
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
        if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
            suppressPreviewToTextUntil = Date.now() + getSyncSuppressionDuration();
            const currentConfig = vscode.workspace.getConfiguration('snaptex');
            if (currentConfig.get<boolean>('livePreview', true)) {
                debouncedUpdatePreview(false);
            }
        }
    }));

    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && vscode.workspace.getConfiguration('snaptex').get<boolean>('renderOnSwitch', false)) {
            updatePreview(true);
        }
    }));

    if (vscode.window.registerWebviewPanelSerializer) {
        context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(TexPreviewPanel.viewType, {
            async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, _state: unknown) {
                TexPreviewPanel.revive(webviewPanel, context.extensionUri, fileProvider, updateService);
            }
        }));
    }
}

export function deactivate() { }
