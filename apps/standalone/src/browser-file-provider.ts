import type { IFileProvider } from '../../../src/file-provider';
import type { UriLike } from '../../../src/types';

function normalizePath(path: string): string {
    const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function parentDir(path: string): string {
    const normalized = normalizePath(path).replace(/\/+$/g, '');
    const index = normalized.lastIndexOf('/');
    return index <= 0 ? '/' : normalized.slice(0, index);
}

export class BrowserUri implements UriLike {
    public readonly path: string;

    constructor(path: string) {
        this.path = normalizePath(path);
    }

    toString(): string {
        return this.path;
    }
}

/**
 * In-memory file provider shared by desktop browsers and future WebView hosts.
 */
export class BrowserFileProvider implements IFileProvider<BrowserUri> {
    private readonly files = new Map<string, { text: string; mtime: number }>();
    private version = 1;

    setFile(uri: BrowserUri, text: string) {
        this.files.set(uri.path, { text, mtime: this.version++ });
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
