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
    text?: string;
    readText?: () => Promise<string>;
    blob?: Blob;
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
    private readonly files = new Map<string, { text?: string; readText?: () => Promise<string>; blob?: Blob; mtime: number; handle?: BrowserWritableFileHandle; objectUrl?: string }>();
    private version = 1;

    private clear() {
        this.revokeObjectUrls();
        this.files.clear();
    }

    setProjectFiles(files: readonly BrowserProjectFile[]) {
        this.clear();
        files.forEach(file => this.setProjectFile(file));
    }

    setProjectFile(file: BrowserProjectFile) {
        const normalizedPath = normalizeBrowserPath(file.path);
        const existing = this.files.get(normalizedPath);
        if (existing?.objectUrl) {
            this.revokeObjectUrl(existing.objectUrl);
        }
        this.files.set(normalizedPath, {
            text: file.text,
            readText: file.readText,
            blob: file.blob ?? (file.text === undefined ? undefined : new Blob([file.text], { type: 'text/plain' })),
            handle: file.handle ?? existing?.handle,
            mtime: this.version++
        });
    }

    setFile(uri: BrowserUri, text: string, handle?: BrowserWritableFileHandle) {
        this.setFileText(uri.path, text, handle);
    }

    setFileText(path: string, text: string, handle?: BrowserWritableFileHandle) {
        const normalizedPath = normalizeBrowserPath(path);
        const existing = this.files.get(normalizedPath);
        if (existing?.objectUrl) {
            this.revokeObjectUrl(existing.objectUrl);
        }
        this.files.set(normalizedPath, {
            text,
            blob: new Blob([text], { type: 'text/plain' }),
            handle: handle ?? existing?.handle,
            mtime: this.version++
        });
    }

    getResourceUrl(uri: BrowserUri, createObjectUrl: (blob: Blob) => string = blob => URL.createObjectURL(blob)): string | undefined {
        const file = this.files.get(uri.path);
        if (!file?.blob) {
            return undefined;
        }
        if (!file.objectUrl) {
            file.objectUrl = createObjectUrl(file.blob);
        }
        return file.objectUrl;
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
        if (file.text !== undefined) {
            return file.text;
        }
        if (!file.readText) {
            throw new Error(`Missing browser file: ${uri.path}`);
        }
        file.text = await file.readText();
        file.blob ??= new Blob([file.text], { type: 'text/plain' });
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

    private revokeObjectUrls() {
        for (const file of this.files.values()) {
            if (file.objectUrl) {
                this.revokeObjectUrl(file.objectUrl);
            }
        }
    }

    private revokeObjectUrl(url: string) {
        if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            URL.revokeObjectURL(url);
        }
    }
}
