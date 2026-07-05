import type { IFileProvider } from '../../../src/file-provider';
import type { UriLike } from '../../../src/types';

export interface BrowserWritableFileHandle {
    createWritable(): Promise<{
        write(data: string): Promise<void> | void;
        close(): Promise<void> | void;
    }>;
}

export interface BrowserProjectFile {
    path: string;
    text: string;
    handle?: BrowserWritableFileHandle;
}

export function normalizeBrowserPath(path: string): string {
    const parts: string[] = [];
    for (const part of path.replace(/\\/g, '/').split('/')) {
        if (!part || part === '.') {
            continue;
        }
        if (part === '..') {
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    return `/${parts.join('/')}`;
}

function parentDir(path: string): string {
    const normalized = normalizeBrowserPath(path).replace(/\/+$/g, '');
    const index = normalized.lastIndexOf('/');
    return index <= 0 ? '/' : normalized.slice(0, index);
}

export class BrowserUri implements UriLike {
    public readonly path: string;

    constructor(path: string) {
        this.path = normalizeBrowserPath(path);
    }

    toString(): string {
        return this.path;
    }
}

/**
 * In-memory file provider shared by desktop browsers and future WebView hosts.
 */
export class BrowserFileProvider implements IFileProvider<BrowserUri> {
    private readonly files = new Map<string, { text: string; mtime: number; handle?: BrowserWritableFileHandle }>();
    private version = 1;

    private clear() {
        this.files.clear();
    }

    setProjectFiles(files: readonly BrowserProjectFile[]) {
        this.clear();
        files.forEach(file => this.setFileText(file.path, file.text, file.handle));
    }

    setFile(uri: BrowserUri, text: string, handle?: BrowserWritableFileHandle) {
        this.setFileText(uri.path, text, handle);
    }

    setFileText(path: string, text: string, handle?: BrowserWritableFileHandle) {
        const normalizedPath = normalizeBrowserPath(path);
        const existing = this.files.get(normalizedPath);
        this.files.set(normalizedPath, { text, handle: handle ?? existing?.handle, mtime: this.version++ });
    }

    getFileText(uri: BrowserUri): string | undefined {
        return this.files.get(uri.path)?.text;
    }

    async write(uri: BrowserUri, text: string): Promise<boolean> {
        const file = this.files.get(uri.path);
        this.setFile(uri, text);
        if (!file?.handle) {
            return false;
        }

        const writable = await file.handle.createWritable();
        await writable.write(text);
        await writable.close();
        return true;
    }

    async read(uri: BrowserUri): Promise<string> {
        const file = this.files.get(uri.path);
        if (!file) {
            throw new Error(`Missing browser file: ${uri.path}`);
        }
        return file.text;
    }

    async exists(uri: BrowserUri): Promise<boolean> {
        return this.files.has(uri.path);
    }

    async stat(uri: BrowserUri): Promise<{ mtime: number }> {
        return { mtime: this.files.get(uri.path)?.mtime ?? 0 };
    }

    resolve(base: BrowserUri, relative: string): BrowserUri {
        if (relative.startsWith('/')) {
            return new BrowserUri(relative);
        }
        return new BrowserUri(`${base.path.replace(/\/+$/g, '')}/${relative}`);
    }

    dir(uri: BrowserUri): BrowserUri {
        return new BrowserUri(parentDir(uri.path));
    }
}
