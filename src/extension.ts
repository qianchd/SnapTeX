import * as vscode from 'vscode';
import { SmartRenderer } from './renderer';
import { TexPreviewPanel } from './panel';

const renderer = new SmartRenderer();

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('texPreview.start', () => {
            TexPreviewPanel.createOrShow(context.extensionPath, renderer);
        })
    );

    let debounceTimer: NodeJS.Timeout | undefined;
    vscode.workspace.onDidChangeTextDocument(e => {
        if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
            if (debounceTimer) {clearTimeout(debounceTimer);}
            debounceTimer = setTimeout(() => {
                TexPreviewPanel.currentPanel?.update();
            }, 100);
        }
    });
}