import type { UriLike } from './types';

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
