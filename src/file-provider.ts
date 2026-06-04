import * as vscode from 'vscode';
import { normalizeUri } from './utils';

/**
 * Async file-system adapter used by the parser.
 *
 * Keeping this boundary narrow lets document.ts work with local, remote, and
 * virtual VS Code file systems without direct workspace.fs calls.
 */
export interface IFileProvider {
    read(uri: vscode.Uri): Promise<string>;
    readBuffer(uri: vscode.Uri): Promise<Uint8Array>;
    exists(uri: vscode.Uri): Promise<boolean>;
    stat(uri: vscode.Uri): Promise<{ mtime: number }>;
    resolve(base: vscode.Uri, relative: string): vscode.Uri;
    dir(uri: vscode.Uri): vscode.Uri;
}

/**
 * VS Code implementation that prefers dirty open editors before disk reads.
 */
export class VscodeFileProvider implements IFileProvider {
    async read(uri: vscode.Uri): Promise<string> {
        const targetNorm = normalizeUri(uri);
        const openDoc = vscode.workspace.textDocuments.find(d => normalizeUri(d.uri) === targetNorm);

        if (openDoc) {
            return openDoc.getText();
        }

        try {
            const uint8Array = await this.readBuffer(uri);
            return new TextDecoder().decode(uint8Array);
        } catch (e) {
            console.warn(`[SnapTeX] Failed to read file: ${uri.toString()}`, e);
            throw e;
        }
    }

    async readBuffer(uri: vscode.Uri): Promise<Uint8Array> {
        try {
            return await vscode.workspace.fs.readFile(uri);
        } catch (e) {
            console.warn(`[SnapTeX] Failed to read binary file: ${uri.toString()}`, e);
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
