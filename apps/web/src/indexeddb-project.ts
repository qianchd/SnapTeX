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

const DEFAULT_DATABASE_NAME = 'snaptex-browser-workspaces';
const DATABASE_VERSION = 1;

const idb = import('idb');

interface StoredProjectRecord {
    id: string;
    name: string;
    rootPath: string;
    templateId?: string;
    activePath?: string;
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

interface WorkspaceDatabase extends DBSchema {
    projects: {
        key: string;
        value: StoredProjectRecord;
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
}

export interface BrowserImportFile {
    path: string;
    file: Blob;
}

export interface BrowserWorkspaceSummary {
    id: string;
    name: string;
    rootPath: string;
    templateId?: string;
}

export interface BrowserWorkspaceTemplate {
    id: string;
    name: string;
    files: readonly BrowserImportFile[];
}

function createProjectId(): string {
    return globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function fileKey(projectId: string, path: string): string {
    return `${projectId}\u0000${normalizeBrowserPath(path)}`;
}

function now(): number {
    return Date.now();
}

async function contentHash(content: Blob): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', await content.arrayBuffer());
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function projectSummary(record: StoredProjectRecord): BrowserWorkspaceSummary {
    const { id, name, rootPath, templateId } = record;
    return { id, name, rootPath, templateId };
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
        throw new Error('No TeX root file found in the imported project.');
    }
    return candidate;
}

async function touchProject(
    projects: { get(key: string): Promise<StoredProjectRecord | undefined>; put(value: StoredProjectRecord): Promise<string> },
    projectId: string,
    activePath?: string
): Promise<void> {
    const project = await projects.get(projectId);
    if (!project) {
        return;
    }
    const timestamp = now();
    await projects.put({
        ...project,
        activePath: activePath ?? project.activePath,
        lastOpenedAt: timestamp
    });
}

async function readContent(db: IDBPDatabase<WorkspaceDatabase>, key: string): Promise<Blob> {
    const record = await db.get('contents', key);
    if (!record) {
        throw new Error(`Missing browser workspace content: ${key}`);
    }
    return record.content;
}

async function createStoredRecords(projectId: string, files: readonly BrowserImportFile[]) {
    const records: StoredFileDraft[] = [];
    for (const file of files) {
        const key = fileKey(projectId, file.path);
        const hash = await contentHash(file.file);
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
                const transaction = db.transaction(['files', 'contents', 'projects'], 'readwrite');
                transaction.objectStore('contents').put({ key: record.key, content });
                transaction.objectStore('files').put({ ...record, currentHash });
                await touchProject(transaction.objectStore('projects'), record.projectId);
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
            upgrade(db) {
                db.createObjectStore('projects', { keyPath: 'id' });
                const files = db.createObjectStore('files', { keyPath: 'key' });
                files.createIndex('by-project', 'projectId');
                db.createObjectStore('contents', { keyPath: 'key' });
            }
        }));
    }

    async list(): Promise<BrowserWorkspaceSummary[]> {
        const projects = await (await this.database).getAll('projects');
        return projects
            .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
            .map(projectSummary);
    }

    async importFiles(name: string, files: readonly BrowserImportFile[]): Promise<BrowserWorkspaceSummary> {
        return this.createWorkspace(name, normalizeImportFiles(files));
    }

    async reimportFiles(id: string, files: readonly BrowserImportFile[], overwriteConflicts = false): Promise<readonly string[]> {
        const normalizedFiles = normalizeImportFiles(files);
        if (normalizedFiles.length === 0) {
            throw new Error('The imported project contains no supported files.');
        }
        const db = await this.database;
        const project = await db.get('projects', id);
        if (!project) {
            throw new Error(`Browser project does not exist: ${id}`);
        }
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

        const timestamp = now();
        const updatedProject: StoredProjectRecord = {
            ...project,
            rootPath: incomingByPath.has(project.rootPath) ? project.rootPath : rootPathFor(normalizedFiles),
            activePath: project.activePath && incomingByPath.has(project.activePath) ? project.activePath : undefined,
            lastOpenedAt: timestamp
        };
        const transaction = db.transaction(['projects', 'files', 'contents'], 'readwrite');
        transaction.objectStore('projects').put(updatedProject);
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
            if (!existing || existing.currentHash !== record.currentHash) {
                transaction.objectStore('contents').put(record.content);
            }
        }
        await transaction.done;
        return [];
    }

    async createFromTemplate(template: BrowserWorkspaceTemplate): Promise<BrowserWorkspaceSummary> {
        const project = await this.createWorkspace(template.name, normalizeImportFiles(template.files), {
            templateId: template.id
        });
        return project;
    }

    async open(id: string): Promise<BrowserProject> {
        const db = await this.database;
        const project = await db.get('projects', id);
        if (!project) {
            throw new Error(`Browser project does not exist: ${id}`);
        }
        const records = await db.getAllFromIndex('files', 'by-project', id);
        const activePath = project.activePath && records.some(record => record.path === project.activePath)
            ? project.activePath
            : project.rootPath;
        await this.touch(id, activePath);
        return {
            id: project.id,
            name: project.name,
            autosave: true,
            rootPath: project.rootPath,
            activePath,
            setActivePath: activePath => this.touch(id, activePath),
            setRootPath: rootPath => this.setRootPath(id, rootPath),
            files: records.map(record => createProjectFile(db, record)),
            operations: {
                createTextFile: (path, text) => this.createTextFile(id, path, text),
                deleteFile: path => this.deleteFile(id, path)
            }
        };
    }

    async delete(id: string): Promise<void> {
        const db = await this.database;
        const records = await db.getAllFromIndex('files', 'by-project', id);
        const transaction = db.transaction(['projects', 'files', 'contents'], 'readwrite');
        transaction.objectStore('projects').delete(id);
        for (const record of records) {
            transaction.objectStore('files').delete(record.key);
            transaction.objectStore('contents').delete(record.key);
        }
        await transaction.done;
    }

    async touch(id: string, activePath?: string): Promise<void> {
        const db = await this.database;
        const transaction = db.transaction('projects', 'readwrite');
        await touchProject(transaction.objectStore('projects'), id, activePath);
        await transaction.done;
    }

    private async setRootPath(id: string, rootPath: string): Promise<void> {
        const db = await this.database;
        const project = await db.get('projects', id);
        if (!project) {
            throw new Error(`Browser project does not exist: ${id}`);
        }
        const normalizedPath = normalizeBrowserPath(rootPath);
        if (!isTexFile(normalizedPath) || !await db.get('files', fileKey(id, normalizedPath))) {
            throw new Error(`Browser project root does not exist: ${normalizedPath}`);
        }
        project.rootPath = normalizedPath;
        project.lastOpenedAt = now();
        await db.put('projects', project);
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
        template: Pick<StoredProjectRecord, 'templateId'> = {}
    ): Promise<BrowserWorkspaceSummary> {
        if (files.length === 0) {
            throw new Error('The imported project contains no supported files.');
        }
        const rootPath = rootPathFor(files);
        const projectId = createProjectId();
        const timestamp = now();
        const project: StoredProjectRecord = {
            id: projectId,
            name: name.trim() || 'Browser Project',
            rootPath,
            ...template,
            lastOpenedAt: timestamp
        };
        const records = await createStoredRecords(projectId, files);
        const db = await this.database;
        const transaction = db.transaction(['projects', 'files', 'contents'], 'readwrite');
        transaction.objectStore('projects').put(project);
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
        if (!await db.get('projects', projectId)) {
            throw new Error(`Browser project does not exist: ${projectId}`);
        }
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
        const transaction = db.transaction(['files', 'contents', 'projects'], 'readwrite');
        transaction.objectStore('files').put(record);
        transaction.objectStore('contents').put({ key, content });
        await touchProject(transaction.objectStore('projects'), projectId);
        await transaction.done;
        return createProjectFile(db, record);
    }

    private async deleteFile(projectId: string, path: string): Promise<void> {
        const normalizedPath = normalizeBrowserPath(path);
        const key = fileKey(projectId, normalizedPath);
        const db = await this.database;
        const project = await db.get('projects', projectId);
        if (!project) {
            throw new Error(`Browser project does not exist: ${projectId}`);
        }
        if (project.rootPath === normalizedPath) {
            throw new Error('The preview root cannot be deleted. Set another root first.');
        }
        if (!await db.get('files', key)) {
            throw new Error(`Browser project file does not exist: ${normalizedPath}`);
        }
        const transaction = db.transaction(['files', 'contents', 'projects'], 'readwrite');
        transaction.objectStore('files').delete(key);
        transaction.objectStore('contents').delete(key);
        await touchProject(transaction.objectStore('projects'), projectId);
        await transaction.done;
    }
}
