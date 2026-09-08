import type { DBSchema, IDBPDatabase } from 'idb' with { 'resolution-mode': 'import' };
import {
    chooseRootPath,
    isProjectFile,
    isProjectTextFile,
    isTexFile,
    normalizeBrowserPath,
    type BrowserProject,
    type BrowserProjectFile
} from '../../standalone/src/browser-project';
import type { BrowserDirectoryHandle } from './local-project';

const DEFAULT_DATABASE_NAME = 'snaptex-browser-workspaces';
const DATABASE_VERSION = 4;

const idb = import('idb');

interface StoredProjectRecord {
    id: string;
    name: string;
    templateId?: string;
}

interface StoredProjectState {
    id: string;
    rootPath: string;
    activePath: string;
    lastOpenedAt: number;
}

interface StoredFileRecord {
    key: string;
    projectId: string;
    path: string;
    baseHash: string;
    currentHash: string;
    localOnly?: boolean;
}

interface StoredContentRecord {
    key: string;
    content: Blob;
}

interface StoredHistoryRecord {
    id: string;
    kind: 'directory' | 'remote';
    name: string;
    directory?: BrowserDirectoryHandle;
    projectName?: string;
}

interface WorkspaceDatabase extends DBSchema {
    projects: {
        key: string;
        value: StoredProjectRecord;
    };
    projectStates: {
        key: string;
        value: StoredProjectState;
    };
    files: {
        key: string;
        value: StoredFileRecord;
        indexes: { 'by-project': string };
    };
    contents: {
        key: string;
        value: StoredContentRecord;
    };
    history: {
        key: string;
        value: StoredHistoryRecord;
    };
}

export interface BrowserImportFile {
    path: string;
    file: Blob;
}

interface BrowserWorkspaceSummary {
    id: string;
    name: string;
    templateId?: string;
}

export interface ProjectHistoryEntry {
    id: string;
    kind: 'workspace' | 'directory' | 'remote';
    name: string;
    detail: string;
    lastOpenedAt: number;
}

function createProjectId(): string {
    return globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function fileKey(projectId: string, path: string): string {
    return `${projectId}\u0000${normalizeBrowserPath(path)}`;
}

async function contentHash(content: Blob): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', await content.arrayBuffer());
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function projectSummary(record: StoredProjectRecord): BrowserWorkspaceSummary {
    const { id, name, templateId } = record;
    return { id, name, templateId };
}

function commonImportRoot(paths: readonly string[]): string | undefined {
    const parts = paths.map(path => normalizeBrowserPath(path).split('/').filter(Boolean));
    if (parts.length === 0 || parts.some(path => path.length < 2)) {
        return undefined;
    }
    const firstParts = parts.map(path => path[0]);
    if (new Set(firstParts).size !== 1) {
        return undefined;
    }
    return firstParts[0];
}

function normalizeImportFiles(files: readonly BrowserImportFile[]): BrowserImportFile[] {
    const normalized = files
        .map(file => ({ path: normalizeBrowserPath(file.path), file: file.file }))
        .filter(file => isProjectFile(file.path));
    const root = commonImportRoot(normalized.map(file => file.path));
    const result = normalized.map(file => {
        if (!root) {
            return file;
        }
        const prefix = `/${root}`;
        return {
            ...file,
            path: file.path === prefix ? '/' : file.path.startsWith(`${prefix}/`)
                ? file.path.slice(prefix.length)
                : file.path
        };
    });
    const seen = new Set<string>();
    return result.filter(file => {
        if (seen.has(file.path)) {
            return false;
        }
        seen.add(file.path);
        return file.path !== '/';
    });
}

function rootPathFor(files: readonly { path: string }[]): string {
    const candidate = chooseRootPath(files.map(file => ({ path: file.path })));
    if (!candidate) {
        throw new Error('No TeX root file found in the project.');
    }
    return candidate;
}

async function readContent(db: IDBPDatabase<WorkspaceDatabase>, key: string): Promise<Blob> {
    const record = await db.get('contents', key);
    if (!record) {
        throw new Error(`Missing browser workspace content: ${key}`);
    }
    return record.content;
}

async function readProject(db: IDBPDatabase<WorkspaceDatabase>, id: string): Promise<StoredProjectRecord> {
    const project = await db.get('projects', id);
    if (!project) {
        throw new Error(`Browser project does not exist: ${id}`);
    }
    return project;
}

async function createStoredRecords(projectId: string, files: readonly BrowserImportFile[]) {
    const records: StoredFileDraft[] = [];
    for (const file of files) {
        const key = fileKey(projectId, file.path);
        const hash = isProjectTextFile(file.path) ? await contentHash(file.file) : '';
        records.push({
            key,
            projectId,
            path: normalizeBrowserPath(file.path),
            baseHash: hash,
            currentHash: hash,
            content: { key, content: file.file }
        });
    }
    return records;
}

type StoredFileDraft = StoredFileRecord & { content: StoredContentRecord };

function fileMetadata(record: StoredFileDraft): StoredFileRecord {
    const { content: _content, ...metadata } = record;
    return metadata;
}

function createProjectFile(
    db: IDBPDatabase<WorkspaceDatabase>,
    record: StoredFileRecord
): BrowserProjectFile {
    const readBlob = () => readContent(db, record.key);
    return {
        path: record.path,
        readBlob,
        readText: isProjectTextFile(record.path) ? async () => (await readBlob()).text() : undefined,
        writeText: isProjectTextFile(record.path)
            ? async text => {
                const content = new Blob([text], { type: 'text/plain;charset=utf-8' });
                const currentHash = await contentHash(content);
                const transaction = db.transaction(['files', 'contents'], 'readwrite');
                transaction.objectStore('contents').put({ key: record.key, content });
                transaction.objectStore('files').put({ ...record, currentHash });
                await transaction.done;
                record.currentHash = currentHash;
            }
            : undefined
    };
}

export class BrowserWorkspaceStore {
    private readonly database: Promise<IDBPDatabase<WorkspaceDatabase>>;

    constructor(private readonly databaseName = DEFAULT_DATABASE_NAME) {
        this.database = idb.then(({ openDB }) => openDB<WorkspaceDatabase>(databaseName, DATABASE_VERSION, {
            upgrade(db, oldVersion, _newVersion, transaction) {
                if (oldVersion < 1) {
                    db.createObjectStore('projects', { keyPath: 'id' });
                    const files = db.createObjectStore('files', { keyPath: 'key' });
                    files.createIndex('by-project', 'projectId');
                    db.createObjectStore('contents', { keyPath: 'key' });
                }
                if (oldVersion < 2) {
                    db.createObjectStore('history', { keyPath: 'id' });
                }
                if (oldVersion < 3) {
                    db.createObjectStore('projectStates', { keyPath: 'id' });
                }
                if (oldVersion < 4) {
                    const states = transaction.objectStore('projectStates');
                    const projects = transaction.objectStore('projects');
                    void projects.openCursor().then(function migrateProjects(cursor): Promise<void> | void {
                        if (!cursor) {
                            return;
                        }
                        const {
                            rootPath,
                            activePath,
                            lastOpenedAt,
                            ...project
                        } = cursor.value as StoredProjectRecord & Partial<Omit<StoredProjectState, 'id'>>;
                        cursor.update(project);
                        return states.get(project.id).then(current => {
                            const existing = current as Partial<StoredProjectState> | undefined;
                            const root = existing?.rootPath ?? rootPath;
                            if (root) {
                                states.put({
                                    id: project.id,
                                    rootPath: root,
                                    activePath: existing?.activePath ?? activePath ?? root,
                                    lastOpenedAt: existing?.lastOpenedAt ?? lastOpenedAt ?? 0
                                });
                            }
                            return cursor.continue().then(migrateProjects);
                        });
                    });

                    const history = transaction.objectStore('history');
                    void history.openCursor().then(function migrateHistory(cursor): Promise<void> | void {
                        if (!cursor) {
                            return;
                        }
                        const { lastOpenedAt, ...entry } = cursor.value as StoredHistoryRecord & { lastOpenedAt?: number };
                        if (lastOpenedAt !== undefined) {
                            cursor.update(entry);
                        }
                        return states.get(entry.id).then(current => {
                            const existing = current as Partial<StoredProjectState> | undefined;
                            if (existing?.rootPath) {
                                states.put({
                                    id: entry.id,
                                    rootPath: existing.rootPath,
                                    activePath: existing.activePath ?? existing.rootPath,
                                    lastOpenedAt: existing.lastOpenedAt ?? lastOpenedAt ?? 0
                                });
                            }
                            return cursor.continue().then(migrateHistory);
                        });
                    });
                }
            }
        }));
    }

    async list(): Promise<BrowserWorkspaceSummary[]> {
        const db = await this.database;
        const [projects, states] = await Promise.all([db.getAll('projects'), db.getAll('projectStates')]);
        const lastOpened = new Map(states.map(state => [state.id, state.lastOpenedAt]));
        return projects
            .sort((a, b) => (lastOpened.get(b.id) ?? 0) - (lastOpened.get(a.id) ?? 0))
            .map(projectSummary);
    }

    async listHistory(): Promise<ProjectHistoryEntry[]> {
        const db = await this.database;
        const [projects, states, history] = await Promise.all([
            db.getAll('projects'),
            db.getAll('projectStates'),
            db.getAll('history')
        ]);
        const stateById = new Map(states.map(state => [state.id, state]));
        return [
            ...projects.map(project => ({
                id: project.id,
                kind: 'workspace' as const,
                name: project.name,
                detail: stateById.get(project.id)?.rootPath ?? 'Browser workspace',
                lastOpenedAt: stateById.get(project.id)?.lastOpenedAt ?? 0
            })),
            ...history.map(entry => ({
                id: entry.id,
                kind: entry.kind,
                name: entry.name,
                detail: entry.kind === 'remote' ? 'Server project' : 'Local folder',
                lastOpenedAt: stateById.get(entry.id)?.lastOpenedAt ?? 0
            }))
        ].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    }

    async rememberDirectory(directory: BrowserDirectoryHandle): Promise<string> {
        const db = await this.database;
        const history = await db.getAll('history');
        let existing: StoredHistoryRecord | undefined;
        if (directory.isSameEntry) {
            for (const entry of history) {
                if (entry.kind === 'directory' && entry.directory && await directory.isSameEntry(entry.directory)) {
                    existing = entry;
                    break;
                }
            }
        }
        const id = existing?.id ?? `directory:${createProjectId()}`;
        await db.put('history', { id, kind: 'directory', name: directory.name, directory });
        return id;
    }

    async rememberRemote(projectName: string): Promise<string> {
        const id = `remote:${projectName}`;
        const db = await this.database;
        await db.put('history', {
            id,
            kind: 'remote',
            name: projectName,
            projectName
        });
        return id;
    }

    async directory(id: string): Promise<BrowserDirectoryHandle> {
        const db = await this.database;
        const entry = await db.get('history', id);
        if (entry?.kind !== 'directory' || !entry.directory) {
            throw new Error('Local folder history is no longer available.');
        }
        return entry.directory;
    }

    async remoteProjectName(id: string): Promise<string> {
        const db = await this.database;
        const entry = await db.get('history', id);
        if (entry?.kind !== 'remote' || !entry.projectName) {
            throw new Error('Server project history is no longer available.');
        }
        return entry.projectName;
    }

    async restoreProjectState(id: string, project: BrowserProject): Promise<BrowserProject> {
        const db = await this.database;
        const state = await db.get('projectStates', id);
        const paths = new Set(project.files.map(file => normalizeBrowserPath(file.path)));
        const rootPath = state && isTexFile(state.rootPath) && paths.has(state.rootPath)
            ? state.rootPath
            : project.rootPath ?? rootPathFor(project.files);
        const requestedActivePath = state?.activePath ?? project.activePath;
        const activePath = requestedActivePath && paths.has(requestedActivePath) ? requestedActivePath : rootPath;
        let currentState: StoredProjectState = { id, rootPath, activePath, lastOpenedAt: Date.now() };
        await db.put('projectStates', currentState);
        const saveState = async (updates: Partial<Pick<StoredProjectState, 'rootPath' | 'activePath'>>) => {
            currentState = { ...currentState, ...updates, lastOpenedAt: Date.now() };
            await db.put('projectStates', currentState);
        };
        return {
            ...project,
            rootPath,
            activePath,
            setRootPath: async path => {
                const normalizedPath = normalizeBrowserPath(path);
                await project.setRootPath?.(normalizedPath);
                await saveState({ rootPath: normalizedPath });
            },
            setActivePath: async path => {
                const normalizedPath = normalizeBrowserPath(path);
                await project.setActivePath?.(normalizedPath);
                await saveState({ activePath: normalizedPath });
            }
        };
    }

    async forgetHistory(id: string): Promise<void> {
        const db = await this.database;
        const transaction = db.transaction(['history', 'projectStates'], 'readwrite');
        transaction.objectStore('history').delete(id);
        transaction.objectStore('projectStates').delete(id);
        await transaction.done;
    }

    async importFiles(name: string, files: readonly BrowserImportFile[], templateId?: string): Promise<BrowserWorkspaceSummary> {
        return this.createWorkspace(name, normalizeImportFiles(files), templateId);
    }

    async reimportFiles(id: string, files: readonly BrowserImportFile[], overwriteConflicts = false): Promise<readonly string[]> {
        const normalizedFiles = normalizeImportFiles(files);
        if (normalizedFiles.length === 0) {
            throw new Error('The imported project contains no supported files.');
        }
        const db = await this.database;
        await readProject(db, id);
        const oldFiles = await db.getAllFromIndex('files', 'by-project', id);
        const oldByPath = new Map(oldFiles.map(file => [file.path, file]));
        const incoming = await createStoredRecords(id, normalizedFiles);
        const incomingByPath = new Map(incoming.map(record => [record.path, record]));
        const conflicts = incoming.flatMap(record => {
            const existing = oldByPath.get(record.path);
            if (!existing) {
                return [];
            }
            const localChange = existing.localOnly === true || existing.currentHash !== existing.baseHash;
            const sourceChange = existing.localOnly === true || record.currentHash !== existing.baseHash;
            return localChange && sourceChange && existing.currentHash !== record.currentHash ? [record.path] : [];
        });
        conflicts.push(...oldFiles.flatMap(existing => {
            const localChange = existing.localOnly === true || existing.currentHash !== existing.baseHash;
            return localChange && !incomingByPath.has(existing.path) ? [existing.path] : [];
        }));
        if (conflicts.length > 0 && !overwriteConflicts) {
            return conflicts;
        }

        const state = await db.get('projectStates', id);
        const rootPath = state && incomingByPath.has(state.rootPath) ? state.rootPath : rootPathFor(normalizedFiles);
        const activePath = state && incomingByPath.has(state.activePath) ? state.activePath : rootPath;
        const transaction = db.transaction(['projectStates', 'files', 'contents'], 'readwrite');
        transaction.objectStore('projectStates').put({ id, rootPath, activePath, lastOpenedAt: Date.now() });
        for (const existing of oldFiles) {
            if (!incomingByPath.has(existing.path)) {
                transaction.objectStore('files').delete(existing.key);
                transaction.objectStore('contents').delete(existing.key);
            }
        }
        for (const record of incoming) {
            const existing = oldByPath.get(record.path);
            const keepLocalChange = !overwriteConflicts && existing?.localOnly !== true &&
                existing?.currentHash !== existing?.baseHash && record.currentHash === existing?.baseHash;
            if (keepLocalChange) {
                continue;
            }
            transaction.objectStore('files').put(fileMetadata(record));
            if (!isProjectTextFile(record.path) || !existing || existing.currentHash !== record.currentHash) {
                transaction.objectStore('contents').put(record.content);
            }
        }
        await transaction.done;
        return [];
    }

    async open(id: string): Promise<BrowserProject> {
        const db = await this.database;
        const project = await readProject(db, id);
        const records = await db.getAllFromIndex('files', 'by-project', id);
        return this.restoreProjectState(id, {
            id: project.id,
            name: project.name,
            autosave: true,
            setRootPath: rootPath => this.validateWorkspaceRoot(id, rootPath),
            files: records.map(record => createProjectFile(db, record)),
            operations: {
                createTextFile: (path, text) => this.createTextFile(id, path, text),
                deleteFile: path => this.deleteFile(id, path)
            }
        });
    }

    async delete(id: string): Promise<void> {
        const db = await this.database;
        const records = await db.getAllFromIndex('files', 'by-project', id);
        const transaction = db.transaction(['projects', 'projectStates', 'files', 'contents'], 'readwrite');
        transaction.objectStore('projects').delete(id);
        transaction.objectStore('projectStates').delete(id);
        for (const record of records) {
            transaction.objectStore('files').delete(record.key);
            transaction.objectStore('contents').delete(record.key);
        }
        await transaction.done;
    }

    private async validateWorkspaceRoot(id: string, rootPath: string): Promise<void> {
        const db = await this.database;
        const normalizedPath = normalizeBrowserPath(rootPath);
        if (!isTexFile(normalizedPath) || !await db.get('files', fileKey(id, normalizedPath))) {
            throw new Error(`Browser project root does not exist: ${normalizedPath}`);
        }
    }

    async close(): Promise<void> {
        (await this.database).close();
    }

    async deleteDatabase(): Promise<void> {
        await this.close();
        const { deleteDB } = await idb;
        await deleteDB(this.databaseName);
    }

    private async createWorkspace(
        name: string,
        files: readonly BrowserImportFile[],
        templateId?: string
    ): Promise<BrowserWorkspaceSummary> {
        if (files.length === 0) {
            throw new Error('The imported project contains no supported files.');
        }
        const rootPath = rootPathFor(files);
        const projectId = createProjectId();
        const project: StoredProjectRecord = {
            id: projectId,
            name: name.trim() || 'Browser Project',
            templateId
        };
        const records = await createStoredRecords(projectId, files);
        const db = await this.database;
        const transaction = db.transaction(['projects', 'projectStates', 'files', 'contents'], 'readwrite');
        transaction.objectStore('projects').put(project);
        transaction.objectStore('projectStates').put({
            id: projectId,
            rootPath,
            activePath: rootPath,
            lastOpenedAt: Date.now()
        });
        for (const record of records) {
            transaction.objectStore('files').put(fileMetadata(record));
            transaction.objectStore('contents').put(record.content);
        }
        await transaction.done;
        return projectSummary(project);
    }

    private async createTextFile(projectId: string, path: string, text: string): Promise<BrowserProjectFile> {
        const normalizedPath = normalizeBrowserPath(path);
        if (!isProjectTextFile(normalizedPath)) {
            throw new Error('SnapTeX can only create supported text files.');
        }
        const key = fileKey(projectId, normalizedPath);
        const db = await this.database;
        await readProject(db, projectId);
        if (await db.get('files', key)) {
            throw new Error(`Browser project file already exists: ${normalizedPath}`);
        }
        const content = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const hash = await contentHash(content);
        const record: StoredFileRecord = {
            key,
            projectId,
            path: normalizedPath,
            baseHash: hash,
            currentHash: hash,
            localOnly: true
        };
        const transaction = db.transaction(['files', 'contents'], 'readwrite');
        transaction.objectStore('files').put(record);
        transaction.objectStore('contents').put({ key, content });
        await transaction.done;
        return createProjectFile(db, record);
    }

    private async deleteFile(projectId: string, path: string): Promise<void> {
        const normalizedPath = normalizeBrowserPath(path);
        const key = fileKey(projectId, normalizedPath);
        const db = await this.database;
        await readProject(db, projectId);
        if ((await db.get('projectStates', projectId))?.rootPath === normalizedPath) {
            throw new Error('The preview root cannot be deleted. Set another root first.');
        }
        if (!await db.get('files', key)) {
            throw new Error(`Browser project file does not exist: ${normalizedPath}`);
        }
        const transaction = db.transaction(['files', 'contents'], 'readwrite');
        transaction.objectStore('files').delete(key);
        transaction.objectStore('contents').delete(key);
        await transaction.done;
    }
}
