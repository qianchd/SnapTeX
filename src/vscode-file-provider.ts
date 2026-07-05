import * as vscode from 'vscode';
import type { IFileProvider } from './file-provider';
import { normalizeUri } from './utils';

/**
 * VS Code implementation that prefers dirty open editors before disk reads.
 */
export class VscodeFileProvider implements IFileProvider<vscode.Uri> {
    async read(uri: vscode.Uri): Promise<string> {
        const targetNorm = normalizeUri(uri);
        const openDoc = vscode.workspace.textDocuments.find(d => normalizeUri(d.uri) === targetNorm);

        if (openDoc) {
            return openDoc.getText();
        }

        try {
            const uint8Array = await vscode.workspace.fs.readFile(uri);
            return new TextDecoder().decode(uint8Array);
        } catch (e) {
            console.warn(`[SnapTeX] Failed to read file: ${uri.toString()}`, e);
            throw e;
        }
    }

    async exists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    async stat(uri: vscode.Uri): Promise<{ mtime: number }> {
        try {
            const fileStat = await vscode.workspace.fs.stat(uri);
            return { mtime: fileStat.mtime };
        } catch {
            return { mtime: 0 };
        }
    }

    resolve(base: vscode.Uri, relative: string): vscode.Uri {
        return vscode.Uri.joinPath(base, relative);
    }

    dir(uri: vscode.Uri): vscode.Uri {
        return vscode.Uri.joinPath(uri, '..');
    }
}
