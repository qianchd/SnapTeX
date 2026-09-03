import {
    isProjectFile,
    isProjectTextFile,
    isTexFile,
    normalizeBrowserPath,
    ProjectWriteConflictError,
    type BrowserProject,
    type BrowserProjectFile
} from '../../standalone/src/browser-project';

interface RemoteProjectManifest {
    rootPath: string;
    files: string[];
    revisions: Record<string, string>;
}

const REMOTE_PROJECT_POLL_INTERVAL_MS = 1000;

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
        Object.entries(revisions).some(([path, revision]) => typeof path !== 'string' || typeof revision !== 'string')) {
        throw new Error('Remote project manifest requires rootPath, files, and revisions.');
    }

    const normalizedFiles = [...new Set(files.map(normalizeBrowserPath).filter(isProjectFile))];
    const normalizedRoot = normalizeBrowserPath(rootPath);
    if (!isTexFile(normalizedRoot) || !normalizedFiles.includes(normalizedRoot)) {
        throw new Error('Remote project rootPath must name a TeX file in files.');
    }
    return {
        rootPath: normalizedRoot,
        files: normalizedFiles,
        revisions: Object.fromEntries(Object.entries(revisions)
            .map(([path, revision]) => [normalizeBrowserPath(path), revision])
            .filter(([path]) => normalizedFiles.includes(path)))
    };
}

function createRemoteProjectModel(projectName: string, baseUrl: string, manifest: RemoteProjectManifest, fetcher: typeof fetch): BrowserProject {
    const etags = new Map<string, string>();
    let currentManifest = manifest;

    const readText = async (path: string, conditional = false): Promise<string | undefined> => {
        const url = remoteFileUrl(baseUrl, path);
        const headers = new Headers();
        if (conditional && etags.has(path)) {
            headers.set('If-None-Match', etags.get(path)!);
        }
        const response = await fetcher(url, { credentials: 'same-origin', headers });
        if (response.status === 304) {
            return undefined;
        }
        if (!response.ok) {
            throw requestError(response, 'GET', url);
        }
        const etag = response.headers.get('etag');
        if (etag) {
            etags.set(path, etag);
        }
        return response.text();
    };

    const createFile = (path: string, etag?: string): BrowserProjectFile => {
        if (etag) {
            etags.set(path, etag);
        }
        const url = remoteFileUrl(baseUrl, path);
        return isProjectTextFile(path)
            ? {
                path,
                readText: async () => (await readText(path))!,
                writeText: async text => {
                    if (!etags.has(path)) {
                        await readText(path);
                    }
                    const etag = etags.get(path);
                    if (!etag) {
                        throw new Error(`Remote project server did not provide an ETag for ${path}.`);
                    }
                    const response = await fetcher(url, {
                        method: 'PUT',
                        credentials: 'same-origin',
                        headers: {
                            'Content-Type': 'text/plain; charset=utf-8',
                            'If-Match': etag
                        },
                        body: text
                    });
                    const responseEtag = response.headers.get('etag');
                    if (responseEtag) {
                        etags.set(path, responseEtag);
                    }
                    if (response.status === 412) {
                        throw new ProjectWriteConflictError(path, await response.text());
                    }
                    if (!response.ok) {
                        throw requestError(response, 'PUT', url);
                    }
                }
            }
            : { path, resourceUrl: url };
    };
    return {
        name: projectName,
        rootPath: manifest.rootPath,
        files: manifest.files.map(path => createFile(path)),
        watchTextFiles: (onChange, onError) => {
            let polling = false;
            let stopped = false;
            const poll = async () => {
                if (polling || stopped) {
                    return;
                }
                polling = true;
                try {
                    const response = await fetchOk(fetcher, new URL('manifest', baseUrl).toString());
                    const nextManifest = readManifest(await response.json());
                    for (const [path, revision] of Object.entries(nextManifest.revisions)) {
                        if (revision === currentManifest.revisions[path]) {
                            continue;
                        }
                        const text = await readText(path, true);
                        if (!stopped && text !== undefined) {
                            await onChange({ path, text });
                        }
                    }
                    currentManifest = nextManifest;
                } catch (error) {
                    onError(error);
                } finally {
                    polling = false;
                }
            };
            const timer = globalThis.setInterval(() => void poll(), REMOTE_PROJECT_POLL_INTERVAL_MS);
            return () => {
                stopped = true;
                globalThis.clearInterval(timer);
            };
        },
        operations: {
            createTextFile: async (path, text) => {
                const response = await fetchOk(fetcher, remoteFileUrl(baseUrl, path), {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                    body: text
                });
                return createFile(path, response.headers.get('etag') ?? undefined);
            },
            deleteFile: async path => {
                await fetchOk(fetcher, remoteFileUrl(baseUrl, path), { method: 'DELETE' });
                etags.delete(path);
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
