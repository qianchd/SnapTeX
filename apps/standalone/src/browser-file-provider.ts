import type { IFileProvider } from '../../../src/file-provider';
import type { UriLike } from '../../../src/types';
import { isProjectTextFile, normalizeBrowserPath, type BrowserProjectFile, type BrowserProjectSnapshotFile } from './browser-project';

interface BrowserFileEntry extends Omit<BrowserProjectFile, 'path'> {
    mtime: number;
    objectUrl?: string;
    blobPromise?: Promise<Blob | undefined>;
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
    private readonly files = new Map<string, BrowserFileEntry>();
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
            writeText: file.writeText,
            blob: file.blob,
            readBlob: file.readBlob,
            resourceUrl: file.resourceUrl,
            mtime: this.version++
        });
    }

    deleteProjectFile(path: string) {
        const normalizedPath = normalizeBrowserPath(path);
        const existing = this.files.get(normalizedPath);
        if (existing?.objectUrl) {
            this.revokeObjectUrl(existing.objectUrl);
        }
        this.files.delete(normalizedPath);
    }

    getPaths(): string[] {
        return [...this.files.keys()].sort((a, b) => a.localeCompare(b));
    }

    has(path: string): boolean {
        return this.files.has(normalizeBrowserPath(path));
    }

    isEmpty(): boolean {
        return this.files.size === 0;
    }

    setFile(uri: BrowserUri, text: string) {
        const normalizedPath = uri.path;
        const existing = this.files.get(normalizedPath);
        if (existing?.text === text) {
            return;
        }
        if (existing?.objectUrl) {
            this.revokeObjectUrl(existing.objectUrl);
        }
        this.files.set(normalizedPath, {
            ...existing,
            text,
            writeText: existing?.writeText,
            objectUrl: undefined,
            mtime: this.version++
        });
    }

    async getResourceUrl(uri: BrowserUri, createObjectUrl: (blob: Blob) => string = blob => URL.createObjectURL(blob)): Promise<string | undefined> {
        const file = this.files.get(uri.path);
        if (file?.resourceUrl) {
            return file.resourceUrl;
        }
        if (file?.objectUrl) {
            return file.objectUrl;
        }
        if (!file) {
            return undefined;
        }
        const blob = await this.loadBlob(file);
        if (!blob) {
            return undefined;
        }
        if (!file.objectUrl) {
            file.objectUrl = createObjectUrl(blob);
            if (file.readBlob) {
                file.blob = undefined;
            }
        }
        return file.objectUrl;
    }

    async readBlob(uri: BrowserUri): Promise<Blob> {
        const file = this.files.get(uri.path);
        if (!file) {
            throw new Error(`Missing browser file: ${uri.path}`);
        }
        const blob = await this.loadBlob(file);
        if (blob) {
            return blob;
        }
        throw new Error(`Missing browser resource: ${uri.path}`);
    }

    private loadBlob(file: BrowserFileEntry): Promise<Blob | undefined> {
        if (file.blob) {
            return Promise.resolve(file.blob);
        }
        file.blobPromise ??= (file.readBlob
            ? file.readBlob()
            : file.resourceUrl
                ? fetch(file.resourceUrl).then(async response => {
                    if (!response.ok) {
                        throw new Error('Failed to read browser resource.');
                    }
                    return response.blob();
                })
                : Promise.resolve(undefined))
            .then(blob => {
                file.blob = blob;
                return blob;
            })
            .finally(() => {
                file.blobPromise = undefined;
            });
        return file.blobPromise;
    }

    async snapshot(): Promise<BrowserProjectSnapshotFile[]> {
        const files: BrowserProjectSnapshotFile[] = [];
        for (const path of this.getPaths()) {
            const uri = new BrowserUri(path);
            const file = this.files.get(path);
            if (!file) {
                continue;
            }
            const content = isProjectTextFile(path)
                ? new Blob([await this.read(uri)], { type: 'text/plain;charset=utf-8' })
                : await this.readBlob(uri);
            files.push({ path, content });
        }
        return files;
    }

    async write(uri: BrowserUri, text: string): Promise<boolean> {
        const file = this.files.get(uri.path);
        this.setFile(uri, text);
        if (file?.writeText) {
            await file.writeText(text);
            return true;
        }
        return false;
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
