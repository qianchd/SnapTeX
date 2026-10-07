import { isProjectFile, isProjectTextFile, isUnavailableProjectFileError, normalizeBrowserPath, normalizeProjectText, ProjectWriteConflictError, type BrowserProject, type BrowserProjectFile } from '../../standalone/src/browser-project';

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
                const text = normalizeProjectText(await file.text());
                state.version = fileVersion(file);
                return state.text = text;
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
                    const writable = await handle.createWritable();
                    await writable.write(text);
                    await writable.close();
                    // Post-write metadata may already describe a newer external edit.
                    state.version = '';
                } catch (error) {
                    state.text = normalizedCurrent;
                    state.version = fileVersion(currentFile);
                    throw error;
                }
            }
        };
    }
    return { path, readBlob: async () => {
        state.version ||= 'pending';
        const file = await handle.getFile();
        const blob = await new Response(file).blob();
        state.version = fileVersion(file);
        return blob;
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
            let retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
            const checkWhenVisible = () => {
                if (!document.hidden) {void check();}
            };
            const check = async () => {
                if (stopped) {return;}
                if (checking) {
                    checkAgain = true;
                    return;
                }
                checking = true;
                try {
                    do {
                        checkAgain = false;
                        let failure: unknown;
                        for (const [path, state] of localFiles) {
                            const textFile = isProjectTextFile(path);
                            try {
                                // Never poll untouched binary resources. Their first read establishes a revision.
                                if (!textFile && !state.version) {continue;}
                                const previousVersion = state.version;
                                const previousText = state.text;
                                const file = await state.handle.getFile();
                                if (stopped) {return;}
                                const version = fileVersion(file);
                                if (version === state.version) {continue;}
                                const text = textFile ? normalizeProjectText(await file.text()) : undefined;
                                const blob = textFile ? undefined : await new Response(file).blob();
                                if (stopped) {return;}
                                if (state.version !== previousVersion || state.text !== previousText) {
                                    checkAgain = true;
                                    continue;
                                }
                                if (text !== undefined) {
                                    if (text !== state.text) {await onChange({ path, text });}
                                } else {
                                    await onResourceChange?.({ path, blob });
                                }
                                // A concurrent save/read may already have advanced this file.
                                if (state.version === previousVersion) {
                                    state.text = text;
                                    state.version = version;
                                } else {checkAgain = true;}
                            } catch (error) {
                                if (isUnavailableProjectFileError(error)) {
                                    if (state.version !== 'unavailable') {
                                        if (!textFile) {await onResourceChange?.({ path });}
                                        else {onError(error);}
                                        state.version = 'unavailable';
                                    }
                                    continue;
                                }
                                if (textFile) {state.version = '';}
                                failure ??= error;
                            }
                        }
                        if (failure !== undefined) {throw failure;}
                    } while (checkAgain && !stopped);
                    globalThis.clearTimeout(retryTimer);
                    retryTimer = undefined;
                } catch (error) {
                    if (!stopped) {
                        if (pollTimer === undefined && retryTimer === undefined) {
                            retryTimer = globalThis.setTimeout(() => {
                                retryTimer = undefined;
                                checkWhenVisible();
                            }, 5000);
                        }
                        onError(error);
                    }
                } finally {
                    checking = false;
                }
            };
            const startPolling = () => {
                if (!stopped && pollTimer === undefined) {
                    pollTimer = globalThis.setInterval(checkWhenVisible, 5000);
                    void check();
                }
            };
            const Observer = (globalThis as typeof globalThis & {
                FileSystemObserver?: BrowserFileSystemObserverConstructor;
            }).FileSystemObserver;
            const observer = Observer ? new Observer(() => void check()) : undefined;
            if (observer) {
                void observer.observe(directory, { recursive: true }).then(check, startPolling);
            } else {
                startPolling();
            }
            document.addEventListener('visibilitychange', checkWhenVisible);
            return () => {
                stopped = true;
                observer?.disconnect();
                globalThis.clearTimeout(retryTimer);
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
                localFiles.delete(normalizeBrowserPath(path));
            }
        }
    };
}
