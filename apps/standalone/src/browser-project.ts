import { normalizeBrowserPath, type BrowserProjectFile, type BrowserWritableFileHandle } from './browser-file-provider';

const PROJECT_TEXT_FILE_PATTERN = /\.(?:tex|bib|sty|cls|bst|txt)$/i;
const PROJECT_RESOURCE_FILE_PATTERN = /\.(?:pdf|png|jpe?g|gif|svg|webp|bmp)$/i;

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

export function isProjectTextFile(path: string): boolean {
    return PROJECT_TEXT_FILE_PATTERN.test(path);
}

export function isProjectFile(path: string): boolean {
    return isProjectTextFile(path) || PROJECT_RESOURCE_FILE_PATTERN.test(path);
}

export function isTexFile(path: string): boolean {
    return /\.tex$/i.test(path);
}

export function chooseRootPath(files: readonly BrowserProjectFile[]): string | undefined {
    const texPaths = files.map(file => file.path).filter(isTexFile);
    return texPaths.find(path => /\/main\.tex$/i.test(path))
        ?? texPaths.find(path => /\/root\.tex$/i.test(path))
        ?? texPaths[0];
}

export function projectTextPaths(files: readonly BrowserProjectFile[]): string[] {
    return files
        .map(file => file.path)
        .map(normalizeBrowserPath)
        .filter(isProjectTextFile)
        .sort((a, b) => a.localeCompare(b));
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
