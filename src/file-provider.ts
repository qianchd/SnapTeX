import type { UriLike } from './types';

/**
 * Async file-system adapter used by the parser.
 *
 * Keeping this boundary narrow lets document.ts work with host-provided file
 * systems without depending on a concrete editor or runtime.
 */
export interface IFileProvider<TUri extends UriLike = UriLike> {
    read(uri: TUri): Promise<string>;
    exists(uri: TUri): Promise<boolean>;
    stat(uri: TUri): Promise<{ mtime: number }>;
    resolve(base: TUri, relative: string): TUri;
    dir(uri: TUri): TUri;
}

/** Resolves a LaTeX resource relative to a directory inside the opened project. */
export function resolveProjectResourcePath(baseDirectory: string, input: unknown): string | undefined {
    if (typeof input !== 'string') { return undefined; }

    const path = input.trim().replace(/\\/g, '/');
    if (!path || path.includes('\0') || path.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(path)) {
        return undefined;
    }

    const base = baseDirectory.replace(/\\/g, '/');
    if (base.includes('\0') || base.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(base)) {
        return undefined;
    }

    const parts: string[] = [];
    for (const part of [...base.split('/'), ...path.split('/')]) {
        if (!part || part === '.') { continue; }
        if (part === '..') {
            if (parts.length === 0) { return undefined; }
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    return parts.length ? parts.join('/') : undefined;
}
