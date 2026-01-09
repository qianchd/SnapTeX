import * as vscode from 'vscode';

/**
 * Interface for file system operations.
 * Adapted for Async operations to support VS Code Web (Virtual File Systems).
 */
export interface IFileProvider {
    read(uri: vscode.Uri): Promise<string>;
    readBuffer(uri: vscode.Uri): Promise<Uint8Array>; // [NEW] Support binary reading
    exists(uri: vscode.Uri): Promise<boolean>;
    stat(uri: vscode.Uri): Promise<{ mtime: number }>;
    resolve(base: vscode.Uri, relative: string): vscode.Uri;
    dir(uri: vscode.Uri): vscode.Uri;
}

/**
 * Universal implementation using vscode.workspace.fs.
 * Works in Desktop, Remote (SSH/WSL), and Web (vscode.dev).
 */
export class VscodeFileProvider implements IFileProvider {
    async read(uri: vscode.Uri): Promise<string> {
        try {
            const uint8Array = await this.readBuffer(uri);
            return new TextDecoder().decode(uint8Array);
        } catch (e) {
            console.warn(`[SnapTeX] Failed to read file: ${uri.toString()}`, e);
            throw e;
        }
    }

    /**
     * [NEW] Read file as binary buffer (essential for PDF)
     */
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