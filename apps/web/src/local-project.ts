import { isProjectFile, isProjectTextFile, normalizeBrowserPath, normalizeProjectText, ProjectWriteConflictError, type BrowserProject, type BrowserProjectFile } from '../../standalone/src/browser-project';

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
    isSameEntry?(other: BrowserDirectoryHandle): Promise<boolean>;
    queryPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
    requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
    values(): AsyncIterable<BrowserFileHandle | BrowserDirectoryHandle>;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<BrowserFileHandle>;
    getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<BrowserDirectoryHandle>;
    removeEntry(name: string): Promise<void>;
}

interface BrowserFileSystemObserver {
    observe(handle: BrowserDirectoryHandle, options: { recursive: boolean }): Promise<void>;
    disconnect(): void;
}

type BrowserFileSystemObserverConstructor = new (callback: () => void) => BrowserFileSystemObserver;

interface LocalFile {
    handle: BrowserFileHandle;
    version: string;
    text?: string;
}

async function ensureDirectoryPermission(directory: BrowserDirectoryHandle): Promise<void> {
    const options = { mode: 'readwrite' } as const;
    if (!directory.queryPermission || await directory.queryPermission(options) === 'granted') {
        return;
    }
    if (!directory.requestPermission || await directory.requestPermission(options) !== 'granted') {
        throw new Error('Permission to open this local folder was not granted.');
    }
}

async function writeText(handle: BrowserFileHandle, text: string): Promise<void> {
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
}

function fileVersion(file: File): string {
    return `${file.size}:${file.lastModified}`;
}

function projectFileFromHandle(
    handle: BrowserFileHandle,
    path: string,
    localFiles: Map<string, LocalFile>
): BrowserProjectFile {
    const state: LocalFile = localFiles.get(path) ?? { handle, version: '' };
    localFiles.set(path, state);
    if (isProjectTextFile(path)) {
        return {
            path,
            readText: async () => {
                const file = await handle.getFile();
                state.version = fileVersion(file);
                return state.text = normalizeProjectText(await file.text());
            },
            writeText: async (text, expectedText) => {
                const currentFile = await handle.getFile();
                const currentText = await currentFile.text();
                const normalizedCurrent = normalizeProjectText(currentText);
                if (expectedText !== undefined && normalizedCurrent !== normalizeProjectText(expectedText)) {
                    state.text = normalizedCurrent;
                    state.version = fileVersion(currentFile);
                    throw new ProjectWriteConflictError(path, currentText);
                }
                state.text = normalizeProjectText(text);
                try {
                    await writeText(handle, text);
                    state.version = fileVersion(await handle.getFile());
                } catch (error) {
                    state.text = normalizedCurrent;
                    state.version = fileVersion(currentFile);
                    throw error;
                }
            }
        };
    }
    return { path, readBlob: async () => {
        const file = await handle.getFile();
        state.version = fileVersion(file);
        return file;
    } };
}

export function fileInputPath(file: File): string {
    return `/${(file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name}`;
}

async function readDirectoryHandle(
    directory: BrowserDirectoryHandle,
    localFiles: Map<string, LocalFile>,
    prefix = ''
): Promise<BrowserProjectFile[]> {
    const files: BrowserProjectFile[] = [];
    for await (const entry of directory.values()) {
        const path = `${prefix}/${entry.name}`;
        if (entry.kind === 'directory') {
            files.push(...await readDirectoryHandle(entry, localFiles, path));
        } else if (isProjectFile(path)) {
            files.push(projectFileFromHandle(entry, path, localFiles));
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
    await ensureDirectoryPermission(directory);
    const localFiles = new Map<string, LocalFile>();
    const files = await readDirectoryHandle(directory, localFiles);
    await Promise.all([...localFiles].filter(([path]) => isProjectTextFile(path)).map(async ([, state]) => {
        state.version = fileVersion(await state.handle.getFile());
    }));
    return {
        name: directory.name,
        files,
        watchFiles: (onChange, onError, onResourceChange) => {
            let checking = false;
            let checkAgain = false;
            let stopped = false;
            let pollTimer: ReturnType<typeof globalThis.setInterval> | undefined;
            const check = async () => {
                if (stopped) {
                    return;
                }
                if (checking) {
                    checkAgain = true;
                    return;
                }
                checking = true;
                try {
                    do {
                        checkAgain = false;
                        for (const [path, state] of localFiles) {
                            // Never poll untouched binary resources. Their first read establishes a revision.
                            if (!isProjectTextFile(path) && !state.version) {continue;}
                            const file = await state.handle.getFile();
                            if (stopped) {return;}
                            const version = fileVersion(file);
                            if (version !== state.version) {
                                state.version = version;
                                if (!isProjectTextFile(path)) {
                                    onResourceChange?.(projectFileFromHandle(state.handle, path, localFiles));
                                    continue;
                                }
                                const text = normalizeProjectText(await file.text());
                                if (stopped) {return;}
                                if (text !== state.text) {
                                    state.text = text;
                                    await onChange({ path, text });
                                }
                            }
                        }
                    } while (checkAgain && !stopped);
                } catch (error) {
                    if (!stopped) {onError(error);}
                } finally {
                    checking = false;
                }
            };
            const startPolling = () => {
                if (!stopped && pollTimer === undefined) {
                    pollTimer = globalThis.setInterval(() => {
                        if (!document.hidden) {void check();}
                    }, 5000);
                }
            };
            const Observer = (globalThis as typeof globalThis & {
                FileSystemObserver?: BrowserFileSystemObserverConstructor;
            }).FileSystemObserver;
            const observer = Observer ? new Observer(() => void check()) : undefined;
            if (observer) {
                void observer.observe(directory, { recursive: true }).catch(startPolling);
            } else {
                startPolling();
            }
            const checkWhenVisible = () => {
                if (!document.hidden) {void check();}
            };
            document.addEventListener('visibilitychange', checkWhenVisible);
            return () => {
                stopped = true;
                observer?.disconnect();
                if (pollTimer !== undefined) {globalThis.clearInterval(pollTimer);}
                document.removeEventListener('visibilitychange', checkWhenVisible);
            };
        },
        operations: {
            createTextFile: async (path, text) => {
                const [parent, name] = await projectFileParent(directory, path, true);
                const handle = await parent.getFileHandle(name, { create: true });
                const normalizedPath = normalizeBrowserPath(path);
                const file = projectFileFromHandle(handle, normalizedPath, localFiles);
                await file.writeText?.(text);
                return file;
            },
            deleteFile: async path => {
                const [parent, name] = await projectFileParent(directory, path);
                await parent.removeEntry(name);
                const normalizedPath = normalizeBrowserPath(path);
                localFiles.delete(normalizedPath);
            }
        }
    };
}
