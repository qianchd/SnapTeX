import type { IFileProvider } from '../../../src/file-provider';
import type { UriLike } from '../../../src/types';
import { isProjectTextFile, normalizeBrowserPath, ProjectFileUnavailableError, type BrowserProjectFile, type BrowserProjectSnapshotFile } from './browser-project';

interface BrowserFileEntry extends Omit<BrowserProjectFile, 'path'> {
    mtime: number;
    objectUrl?: string;
    blobPromise?: Promise<Blob | undefined>;
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
    private readonly requestedResources = new Set<string>();
    private version = 1;

    setProjectFiles(files: readonly BrowserProjectFile[]) {
        for (const file of this.files.values()) {
            this.revokeEntryObjectUrl(file);
        }
        this.files.clear();
        this.requestedResources.clear();
        files.forEach(file => this.setProjectFile(file));
    }

    setProjectFile(file: BrowserProjectFile) {
        const { path, ...entry } = file;
        const normalizedPath = normalizeBrowserPath(path);
        this.revokeEntryObjectUrl(this.files.get(normalizedPath));
        this.files.set(normalizedPath, {
            ...entry,
            objectUrl: undefined,
            mtime: this.version++
        });
    }

    deleteProjectFile(path: string) {
        const normalizedPath = normalizeBrowserPath(path);
        this.revokeEntryObjectUrl(this.files.get(normalizedPath));
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
        const existing = this.files.get(uri.path);
        if (existing?.text === text) {
            return;
        }
        this.setProjectFile({ ...existing, path: uri.path, text });
    }

    async getResourceUrl(uri: BrowserUri, createObjectUrl: (blob: Blob) => string = blob => URL.createObjectURL(blob)): Promise<string | undefined> {
        this.requestedResources.add(uri.path);
        const file = this.files.get(uri.path);
        if (file?.objectUrl) {
            return file.objectUrl;
        }
        if (file?.resourceUrl && !file.readBlob) {
            return file.resourceUrl;
        }
        if (!file) {
            return undefined;
        }
        const blob = await this.loadBlob(file);
        if (!blob || this.files.get(uri.path) !== file) {
            return undefined;
        }
        file.objectUrl ??= createObjectUrl(blob);
        return file.objectUrl;
    }

    /** Read a changed resource before replacing its last usable URL. */
    async refreshResource(file: BrowserProjectFile): Promise<string | undefined> {
        const { path, ...source } = file;
        const blob = await this.loadBlob(source);
        this.setProjectFile({ ...file, blob });
        return this.getResourceUrl(new BrowserUri(path));
    }

    wasResourceRequested(path: string): boolean {
        return this.requestedResources.has(normalizeBrowserPath(path));
    }

    async readBlob(uri: BrowserUri): Promise<Blob> {
        this.requestedResources.add(uri.path);
        return this.loadRequiredBlob(uri);
    }

    private async loadRequiredBlob(uri: BrowserUri): Promise<Blob> {
        const file = this.files.get(uri.path);
        const blob = file && await this.loadBlob(file);
        if (blob) {
            return blob;
        }
        throw new ProjectFileUnavailableError(`Missing browser resource: ${uri.path}`);
    }

    private loadBlob(file: Pick<BrowserFileEntry, 'blob' | 'readBlob' | 'resourceUrl' | 'objectUrl' | 'blobPromise'>): Promise<Blob | undefined> {
        if (file.blob) {
            return Promise.resolve(file.blob);
        }
        file.blobPromise ??= (file.objectUrl && file.resourceUrl
            ? fetch(file.objectUrl).then(response => response.blob())
            : file.readBlob
            ? file.readBlob()
            : file.resourceUrl
                ? fetch(file.resourceUrl, { signal: AbortSignal.timeout(30_000) }).then(async response => {
                    if (!response.ok) {
                        const ErrorType = [401, 403, 404, 410].includes(response.status) ? ProjectFileUnavailableError : Error;
                        throw new ErrorType(`Failed to read browser resource: ${response.status}`);
                    }
                    return response.blob();
                })
                : Promise.resolve(undefined))
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
                : await this.loadRequiredBlob(uri);
            files.push({ path, content });
        }
        return files;
    }

    isWritable(uri: BrowserUri): boolean {
        return typeof this.files.get(uri.path)?.writeText === 'function';
    }

    async write(uri: BrowserUri, text: string, expectedText?: string): Promise<boolean> {
        const file = this.files.get(uri.path);
        this.setFile(uri, text);
        if (file?.writeText) {
            await file.writeText(text, expectedText);
            return true;
        }
        return false;
    }

    async read(uri: BrowserUri): Promise<string> {
        const file = this.files.get(uri.path);
        if (file?.text !== undefined) {
            return file.text;
        }
        if (!file?.readText) {
            throw new Error(`Missing browser file: ${uri.path}`);
        }
        return file.text = await file.readText();
    }

    /** Reads the backing source without replacing unsaved preview text. */
    async readSourceText(uri: BrowserUri): Promise<string> {
        const file = this.files.get(uri.path);
        return file?.readText ? file.readText() : this.read(uri);
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
        const index = uri.path.lastIndexOf('/');
        return new BrowserUri(index > 0 ? uri.path.slice(0, index) : '/');
    }

    private revokeEntryObjectUrl(file: BrowserFileEntry | undefined) {
        if (file?.objectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            URL.revokeObjectURL(file.objectUrl);
        }
    }
}
