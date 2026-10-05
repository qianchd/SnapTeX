import {
    isPdfFile,
    isProjectFile,
    isProjectTextFile,
    isTexFile,
    normalizeBrowserPath,
    normalizeProjectText,
    ProjectWriteConflictError,
    type BrowserProject,
    type BrowserProjectFile
} from '../../standalone/src/browser-project';

interface RemoteProjectManifest {
    rootPath: string;
    files: string[];
    revisions: Record<string, string>;
}

export class RemoteProjectNotFoundError extends Error {
    constructor(projectName: string) {
        super(`Project does not exist: ${projectName}`);
        this.name = 'RemoteProjectNotFoundError';
    }
}

export class RemoteProjectAuthenticationError extends Error {
    constructor() {
        super('Sign in to access remote projects.');
        this.name = 'RemoteProjectAuthenticationError';
    }
}

function requestError(response: Response, method: string, url: string | URL): Error {
    if (response.status === 401) { return new RemoteProjectAuthenticationError(); }
    if (response.status === 503) {
        return new Error('The server cannot read this project. Ask the administrator to repair its permissions.');
    }
    return new Error(`${method} ${response.url || url} failed: ${response.status}`);
}

function remoteFileUrl(apiBaseUrl: string, path: string): string {
    const encodedPath = normalizeBrowserPath(path)
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/');
    return new URL(`files/${encodedPath}`, apiBaseUrl).toString();
}

async function fetchOk(fetcher: typeof fetch, url: string, init?: RequestInit): Promise<Response> {
    const response = await fetcher(url, { credentials: 'same-origin', ...init });
    if (!response.ok) {
        throw requestError(response, init?.method ?? 'GET', url);
    }
    return response;
}

function withCsrf(fetcher: typeof fetch, apiBaseUrl: string): typeof fetch {
    let csrfToken: Promise<string> | undefined;
    return async (input, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
            return fetcher(input, { credentials: 'same-origin', ...init });
        }
        csrfToken ??= fetcher(new URL('../../web-auth/session', apiBaseUrl), { credentials: 'same-origin' })
            .then(async response => {
                if (!response.ok) {
                    throw requestError(response, 'GET', '/web-auth/session');
                }
                const value = await response.json() as { csrfToken?: unknown };
                return typeof value.csrfToken === 'string' ? value.csrfToken : '';
            })
            .catch(error => {
                csrfToken = undefined;
                throw error;
            });
        const token = await csrfToken;
        const headers = new Headers(init?.headers);
        if (token) {
            headers.set('X-CSRF-Token', token);
        }
        return fetcher(input, { ...init, credentials: 'same-origin', headers });
    };
}

function projectUrl(apiBaseUrl: string, projectName: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectName) || projectName === '.' || projectName === '..') {
        throw new Error('Project name may only contain letters, numbers, dots, underscores, and hyphens.');
    }
    const baseUrl = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
    return new URL(`${encodeURIComponent(projectName)}/`, baseUrl).toString();
}

function readManifest(value: unknown): RemoteProjectManifest {
    if (!value || typeof value !== 'object') {
        throw new Error('Remote project manifest must be an object.');
    }
    const { rootPath, files, revisions } = value as Partial<RemoteProjectManifest>;
    if (typeof rootPath !== 'string' || !Array.isArray(files) || files.some(path => typeof path !== 'string') ||
        !revisions || typeof revisions !== 'object' || Array.isArray(revisions) ||
        Object.values(revisions).some(revision => typeof revision !== 'string')) {
        throw new Error('Remote project manifest requires rootPath, files, and revisions.');
    }

    const normalizedFiles = new Set(files.map(normalizeBrowserPath).filter(isProjectFile));
    const normalizedRoot = normalizeBrowserPath(rootPath);
    if (!isTexFile(normalizedRoot) || !normalizedFiles.has(normalizedRoot)) {
        throw new Error('Remote project rootPath must name a TeX file in files.');
    }
    return {
        rootPath: normalizedRoot,
        files: [...normalizedFiles],
        revisions: Object.fromEntries(Object.entries(revisions)
            .map(([path, revision]) => [normalizeBrowserPath(path), revision])
            .filter(([path]) => normalizedFiles.has(path)))
    };
}

function createRemoteProjectModel(projectName: string, baseUrl: string, manifest: RemoteProjectManifest, fetcher: typeof fetch): BrowserProject {
    const versions = new Map<string, { etag: string | null; text: string }>();
    let currentManifest = manifest;

    const readText = async (path: string, conditional = false): Promise<string | undefined> => {
        const url = remoteFileUrl(baseUrl, path);
        const headers = new Headers();
        const etag = versions.get(path)?.etag;
        if (conditional && etag) {
            headers.set('If-None-Match', etag);
        }
        const response = await fetcher(url, { credentials: 'same-origin', headers });
        if (response.status === 304) {
            return undefined;
        }
        if (!response.ok) {
            throw requestError(response, 'GET', url);
        }
        const text = await response.text();
        versions.set(path, { etag: response.headers.get('etag'), text });
        return text;
    };

    const createFile = (path: string): BrowserProjectFile => {
        const url = remoteFileUrl(baseUrl, path);
        return isProjectTextFile(path)
            ? {
                path,
                readText: async () => (await readText(path))!,
                writeText: async (text, expectedText) => {
                    if (!versions.get(path)?.etag) {
                        await readText(path);
                    }
                    const version = versions.get(path);
                    if (!version?.etag) {
                        throw new Error(`Remote project server did not provide an ETag for ${path}.`);
                    }
                    if (expectedText !== undefined && normalizeProjectText(version.text) !== normalizeProjectText(expectedText)) {
                        throw new ProjectWriteConflictError(path, version.text);
                    }
                    const response = await fetcher(url, {
                        method: 'PUT',
                        credentials: 'same-origin',
                        headers: {
                            'Content-Type': 'text/plain; charset=utf-8',
                            'If-Match': version.etag
                        },
                        body: text
                    });
                    if (response.status === 412) {
                        const remoteText = await response.text();
                        versions.set(path, { etag: response.headers.get('etag'), text: remoteText });
                        throw new ProjectWriteConflictError(path, remoteText);
                    }
                    if (!response.ok) {
                        throw requestError(response, 'PUT', url);
                    }
                    versions.set(path, { etag: response.headers.get('etag'), text });
                }
            }
            : { path, resourceUrl: url };
    };
    const postJson = async <T>(route: string, body: unknown): Promise<T> => {
        const url = new URL(route, baseUrl).toString();
        const response = await fetcher(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const result = await response.json().catch(() => undefined) as (T & { error?: string }) | undefined;
        if (!response.ok) {
            throw new Error(result?.error ?? requestError(response, 'POST', url).message);
        }
        if (result === undefined) {
            throw new Error(`POST ${url} returned invalid JSON.`);
        }
        return result;
    };
    return {
        name: projectName,
        rootPath: manifest.rootPath,
        files: manifest.files.map(path => createFile(path)),
        watchFiles: (onChange, onError, onResourceChange) => {
            const pendingText = new Set<string>();
            let manifestPending = false;
            let syncing = false;
            let stopped = false;
            const sync = async () => {
                if (syncing || stopped) {return;}
                syncing = true;
                try {
                    while (!stopped && (manifestPending || pendingText.size > 0)) {
                        if (manifestPending) {
                            manifestPending = false;
                            const previousManifest = currentManifest;
                            const response = await fetchOk(fetcher, new URL('manifest', baseUrl).toString());
                            const manifest = readManifest(await response.json());
                            if (stopped) {return;}
                            currentManifest = manifest;
                            for (const [path, revision] of Object.entries(manifest.revisions)) {
                                if (revision === previousManifest.revisions[path]) {continue;}
                                if (isProjectTextFile(path)) {pendingText.add(path);}
                                else {onResourceChange?.(createFile(path));}
                            }
                        }
                        const paths = [...pendingText];
                        pendingText.clear();
                        for (const path of paths) {
                            if (!currentManifest.files.includes(path)) {continue;}
                            const text = await readText(path, true);
                            if (!stopped && text !== undefined) {await onChange({ path, text });}
                        }
                    }
                } catch (error) {
                    manifestPending = false;
                    pendingText.clear();
                    if (!stopped) {onError(error);}
                } finally {
                    syncing = false;
                }
            };
            const events = new EventSource(new URL('events', baseUrl), { withCredentials: true });
            events.addEventListener('manifest', () => {
                manifestPending = true;
                void sync();
            });
            for (const type of ['text', 'resource']) {
                events.addEventListener(type, event => {
                    try {
                        const path = JSON.parse((event as MessageEvent<string>).data);
                        if (stopped || typeof path !== 'string') {return;}
                        const normalizedPath = normalizeBrowserPath(path);
                        if (currentManifest.files.includes(normalizedPath)) {
                            if (type === 'text') {pendingText.add(normalizedPath);}
                            else {onResourceChange?.(createFile(normalizedPath));}
                        }
                        else {manifestPending = true;}
                        void sync();
                    } catch (error) {onError(error);}
                });
            }
            return () => {
                stopped = true;
                events.close();
            };
        },
        operations: {
            createTextFile: async (path, text) => {
                const response = await fetchOk(fetcher, remoteFileUrl(baseUrl, path), {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                    body: text
                });
                versions.set(path, { etag: response.headers.get('etag'), text });
                return createFile(path);
            },
            deleteFile: async path => {
                await fetchOk(fetcher, remoteFileUrl(baseUrl, path), { method: 'DELETE' });
                versions.delete(path);
            },
            compilePdf: async (rootPath, compiler) => {
                const { path, syncPath } = await postJson<{ path: string; syncPath?: string }>('compile', { rootPath, compiler });
                if (!isPdfFile(path)) {
                    throw new Error('The server returned an invalid PDF path.');
                }
                if (syncPath && !/\.synctex(?:\.gz)?$/i.test(syncPath)) {throw new Error('Invalid SyncTeX path.');}
                return [path, ...(syncPath ? [syncPath] : [])].map(path => createFile(normalizeBrowserPath(path)));
            }
        }
    };
}

/** Maps a named project from the optional SnapTeX HTTP API onto the shared browser project model. */
export async function loadRemoteProject(projectName: string, apiBaseUrl: string, fetcher: typeof fetch = fetch): Promise<BrowserProject> {
    fetcher = withCsrf(fetcher, apiBaseUrl);
    const baseUrl = projectUrl(apiBaseUrl, projectName);
    const response = await fetcher(new URL('manifest', baseUrl));
    if (response.status === 404) {
        const body = await response.json().catch(() => undefined) as { code?: string } | undefined;
        if (body?.code === 'PROJECT_NOT_FOUND') {
            throw new RemoteProjectNotFoundError(projectName);
        }
    }
    if (!response.ok) {
        throw requestError(response, 'GET', new URL('manifest', baseUrl));
    }
    return createRemoteProjectModel(projectName, baseUrl, readManifest(await response.json()), fetcher);
}

export async function createRemoteProject(projectName: string, apiBaseUrl: string, fetcher: typeof fetch = fetch): Promise<BrowserProject> {
    fetcher = withCsrf(fetcher, apiBaseUrl);
    const baseUrl = projectUrl(apiBaseUrl, projectName);
    const response = await fetchOk(fetcher, baseUrl, { method: 'POST' });
    return createRemoteProjectModel(projectName, baseUrl, readManifest(await response.json()), fetcher);
}
