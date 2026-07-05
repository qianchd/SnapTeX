import * as vscode from 'vscode';
import type { UriLike } from './types';
import { normalizeUri } from './utils';

/**
 * Async file-system adapter used by the parser.
 *
 * Keeping this boundary narrow lets document.ts work with local, remote, and
 * virtual VS Code file systems without direct workspace.fs calls.
 */
export interface IFileProvider<TUri extends UriLike = UriLike> {
    read(uri: TUri): Promise<string>;
    exists(uri: TUri): Promise<boolean>;
    stat(uri: TUri): Promise<{ mtime: number }>;
    resolve(base: TUri, relative: string): TUri;
    dir(uri: TUri): TUri;
}

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
