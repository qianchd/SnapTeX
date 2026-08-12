import type { BrowserProjectFile, BrowserWritableFileHandle } from '../../standalone/src/browser-file-provider';
import { isProjectFile, isProjectTextFile } from '../../standalone/src/browser-project';

export interface BrowserFileHandle extends BrowserWritableFileHandle {
    kind: 'file';
    name: string;
    getFile(): Promise<File>;
}

export interface BrowserDirectoryHandle {
    kind: 'directory';
    name: string;
    values(): AsyncIterable<BrowserFileHandle | BrowserDirectoryHandle>;
}

export function projectFileFromFile(file: File, path: string, handle?: BrowserFileHandle): BrowserProjectFile {
    return isProjectTextFile(path)
        ? { path, readText: () => file.text(), handle }
        : { path, blob: file, handle };
}

export async function projectFileFromHandle(handle: BrowserFileHandle, path: string): Promise<BrowserProjectFile> {
    if (isProjectTextFile(path)) {
        return {
            path,
            handle,
            readText: async () => (await handle.getFile()).text()
        };
    }
    return projectFileFromFile(await handle.getFile(), path, handle);
}

export function fileInputPath(file: File): string {
    return `/${(file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name}`;
}

export async function readDirectoryHandle(directory: BrowserDirectoryHandle, prefix = ''): Promise<BrowserProjectFile[]> {
    const files: BrowserProjectFile[] = [];
    for await (const entry of directory.values()) {
        const path = `${prefix}/${entry.name}`;
        if (entry.kind === 'directory') {
            files.push(...await readDirectoryHandle(entry, path));
        } else if (isProjectFile(path)) {
            files.push(await projectFileFromHandle(entry, path));
        }
    }
    return files;
}
