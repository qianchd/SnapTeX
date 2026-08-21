import { isProjectFile, isProjectTextFile, normalizeBrowserPath, type BrowserProject, type BrowserProjectFile } from '../../standalone/src/browser-project';

export interface BrowserFileHandle {
    kind: 'file';
    name: string;
    getFile(): Promise<File>;
    createWritable(): Promise<{
        write(data: string): Promise<void> | void;
        close(): Promise<void> | void;
    }>;
}

export interface BrowserDirectoryHandle {
    kind: 'directory';
    name: string;
    values(): AsyncIterable<BrowserFileHandle | BrowserDirectoryHandle>;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<BrowserFileHandle>;
    getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<BrowserDirectoryHandle>;
    removeEntry(name: string): Promise<void>;
}

async function writeText(handle: BrowserFileHandle, text: string): Promise<void> {
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
}

async function projectFileFromHandle(handle: BrowserFileHandle, path: string): Promise<BrowserProjectFile> {
    if (isProjectTextFile(path)) {
        return {
            path,
            readText: async () => (await handle.getFile()).text(),
            writeText: text => writeText(handle, text)
        };
    }
    return { path, readBlob: async () => handle.getFile() };
}

export function fileInputPath(file: File): string {
    return `/${(file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name}`;
}

async function readDirectoryHandle(directory: BrowserDirectoryHandle, prefix = ''): Promise<BrowserProjectFile[]> {
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

async function projectFileParent(directory: BrowserDirectoryHandle, path: string, create = false): Promise<[BrowserDirectoryHandle, string]> {
    const parts = normalizeBrowserPath(path).split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) {
        throw new Error('File path is empty.');
    }
    for (const part of parts) {
        directory = await directory.getDirectoryHandle(part, { create });
    }
    return [directory, name];
}

/** Opens a writable browser directory as a shared SnapTeX project. */
export async function createDirectoryProject(directory: BrowserDirectoryHandle): Promise<BrowserProject> {
    return {
        name: directory.name,
        files: await readDirectoryHandle(directory),
        operations: {
            createTextFile: async (path, text) => {
                const [parent, name] = await projectFileParent(directory, path, true);
                const handle = await parent.getFileHandle(name, { create: true });
                await writeText(handle, text);
                return projectFileFromHandle(handle, normalizeBrowserPath(path));
            },
            deleteFile: async path => {
                const [parent, name] = await projectFileParent(directory, path);
                await parent.removeEntry(name);
            }
        }
    };
}
