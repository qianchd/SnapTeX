import {
    isPdfFile,
    isProjectFile,
    isProjectTextFile,
    isUnavailableProjectFileError,
    isTexFile,
    normalizeBrowserPath,
    normalizeProjectText,
    ProjectWriteConflictError,
    ProjectFileUnavailableError,
    type BrowserProject,
    type BrowserProjectFile
} from '../../standalone/src/browser-project';

interface RemoteProjectManifest {
    rootPath: string;
    files: string[];
    revisions: Record<string, string>;
}

const PROJECT_SYNC_REQUEST_TIMEOUT_MS = 30_000;

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
    const ErrorType = [403, 404, 410].includes(response.status) ? ProjectFileUnavailableError : Error;
    const message = response.status === 503
        ? 'The server cannot read this project. Ask the administrator to repair its permissions.'
        : `${method} ${response.url || url} failed: ${response.status}`;
    return new ErrorType(message);
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
        csrfToken ??= fetchOk(fetcher, new URL('../../web-auth/session', apiBaseUrl).toString())
            .then(async response => {
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
    const pendingPaths = new Set<string>();
    let requestSync: (() => void) | undefined;
    let currentManifest = manifest;

    const readText = async (path: string, conditional = false, signal?: AbortSignal): Promise<string | undefined> => {
        const url = remoteFileUrl(baseUrl, path);
        while (true) {
            const version = versions.get(path);
            const timeout = AbortSignal.timeout(PROJECT_SYNC_REQUEST_TIMEOUT_MS);
            const response = await fetcher(url, {
                headers: conditional && version?.etag ? { 'If-None-Match': version.etag } : undefined,
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
            if (response.status === 304) {return undefined;}
            if (!response.ok) {throw requestError(response, 'GET', url);}
            const text = await response.text();
            // A save or another read may have completed while this response was in flight.
            if (versions.get(path) !== version) {continue;}
            versions.set(path, { etag: response.headers.get('etag'), text });
            return text;
        }
    };

    const createFile = (path: string, signal?: AbortSignal): BrowserProjectFile => {
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
            : { path, resourceUrl: url, readBlob: async () => {
                const timeout = AbortSignal.timeout(PROJECT_SYNC_REQUEST_TIMEOUT_MS);
                try {
                    return await (await fetchOk(fetcher, url, {
                        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
                    })).blob();
                } catch (error) {
                    // Watcher reads already return failures to its retry loop.
                    if (!signal && !isUnavailableProjectFileError(error) && !(error instanceof RemoteProjectAuthenticationError)) {
                        pendingPaths.add(path);
                        requestSync?.();
                    }
                    throw error;
                }
            } };
    };
    return {
        name: projectName,
        rootPath: manifest.rootPath,
        files: manifest.files.map(path => createFile(path)),
        watchFiles: (onChange, onError, onResourceChange) => {
            const controller = new AbortController();
            let manifestPending = false;
            let syncing = false;
            let stopped = false;
            let retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
            let retryDelayMs = 1000;
            const sync = async () => {
                if (syncing || stopped || retryTimer !== undefined) {return;}
                syncing = true;
                try {
                    while (!stopped && (manifestPending || pendingPaths.size > 0)) {
                        if (manifestPending) {
                            manifestPending = false;
                            const previousManifest = currentManifest;
                            const manifest = await fetchOk(fetcher, new URL('manifest', baseUrl).toString(), {
                                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(PROJECT_SYNC_REQUEST_TIMEOUT_MS)])
                            }).then(response => response.json()).then(readManifest).catch(error => {
                                manifestPending = true;
                                throw error;
                            });
                            if (stopped) {return;}
                            currentManifest = manifest;
                            for (const path of new Set([...Object.keys(previousManifest.revisions), ...Object.keys(manifest.revisions)])) {
                                if (manifest.revisions[path] === previousManifest.revisions[path]) {continue;}
                                pendingPaths.add(path);
                            }
                        }
                        let failure: unknown;
                        for (const path of [...pendingPaths]) {
                            if (stopped) {return;}
                            pendingPaths.delete(path);
                            try {
                                if (!currentManifest.files.includes(path)) {
                                    if (!isProjectTextFile(path)) {await onResourceChange?.({ path });}
                                    continue;
                                }
                                if (isProjectTextFile(path)) {
                                    const text = await readText(path, true, controller.signal);
                                    if (pendingPaths.has(path)) {versions.delete(path); continue;}
                                    if (!stopped && text !== undefined) {await onChange({ path, text });}
                                } else {
                                    await onResourceChange?.(createFile(path, controller.signal));
                                }
                            } catch (error) {
                                if (isUnavailableProjectFileError(error)) {onError(error); continue;}
                                pendingPaths.add(path);
                                // A received ETag is not proof that the editor applied the update.
                                versions.delete(path);
                                failure ??= error;
                            }
                        }
                        if (failure !== undefined) {throw failure;}
                    }
                    retryDelayMs = 1000;
                } catch (error) {
                    if (!stopped) {
                        if (!isUnavailableProjectFileError(error) && !(error instanceof RemoteProjectAuthenticationError)) {
                            retryTimer = globalThis.setTimeout(() => {
                                retryTimer = undefined;
                                void sync();
                            }, retryDelayMs);
                            retryDelayMs = Math.min(30_000, retryDelayMs * 2);
                        }
                        onError(error);
                    }
                } finally {
                    syncing = false;
                }
            };
            const resume = () => {
                if (stopped) {return;}
                globalThis.clearTimeout(retryTimer);
                retryTimer = undefined;
                manifestPending = true;
                void sync();
            };
            const checkWhenVisible = () => {
                if (!globalThis.document?.hidden) {resume();}
            };
            globalThis.addEventListener?.('online', resume);
            globalThis.document?.addEventListener('visibilitychange', checkWhenVisible);
            const events = new EventSource(new URL('events', baseUrl), { withCredentials: true });
            events.addEventListener('manifest', resume);
            for (const type of ['text', 'resource']) {
                events.addEventListener(type, event => {
                    try {
                        const path = JSON.parse((event as MessageEvent<string>).data);
                        if (stopped || typeof path !== 'string') {return;}
                        const normalizedPath = normalizeBrowserPath(path);
                        if (currentManifest.files.includes(normalizedPath)) {
                            pendingPaths.add(normalizedPath);
                        }
                        else {manifestPending = true;}
                        void sync();
                    } catch (error) {onError(error);}
                });
            }
            requestSync = () => {void sync();};
            if (pendingPaths.size > 0) {requestSync();}
            return () => {
                stopped = true;
                requestSync = undefined;
                pendingPaths.clear();
                controller.abort();
                globalThis.clearTimeout(retryTimer);
                globalThis.removeEventListener?.('online', resume);
                globalThis.document?.removeEventListener('visibilitychange', checkWhenVisible);
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
                const url = new URL('compile', baseUrl).toString();
                const response = await fetcher(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rootPath, compiler })
                });
                const result = await response.json().catch(() => undefined) as { path: string; syncPath?: string; error?: string } | undefined;
                if (!response.ok) {throw new Error(result?.error ?? requestError(response, 'POST', url).message);}
                if (!result) {throw new Error(`POST ${url} returned invalid JSON.`);}
                const { path, syncPath } = result;
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
