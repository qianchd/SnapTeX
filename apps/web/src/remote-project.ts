import { isProjectFile, isProjectTextFile, isTexFile, normalizeBrowserPath, type BrowserProject, type BrowserProjectFile } from '../../standalone/src/browser-project';

interface RemoteProjectManifest {
    rootPath: string;
    files: string[];
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
    return response.status === 401
        ? new RemoteProjectAuthenticationError()
        : new Error(`${method} ${response.url || url} failed: ${response.status}`);
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
    const { rootPath, files } = value as Partial<RemoteProjectManifest>;
    if (typeof rootPath !== 'string' || !Array.isArray(files) || files.some(path => typeof path !== 'string')) {
        throw new Error('Remote project manifest requires rootPath and files.');
    }

    const normalizedFiles = [...new Set(files.map(normalizeBrowserPath).filter(isProjectFile))];
    const normalizedRoot = normalizeBrowserPath(rootPath);
    if (!isTexFile(normalizedRoot) || !normalizedFiles.includes(normalizedRoot)) {
        throw new Error('Remote project rootPath must name a TeX file in files.');
    }
    return { rootPath: normalizedRoot, files: normalizedFiles };
}

function createRemoteProjectModel(projectName: string, baseUrl: string, manifest: RemoteProjectManifest, fetcher: typeof fetch): BrowserProject {
    const createFile = (path: string): BrowserProjectFile => {
        const url = remoteFileUrl(baseUrl, path);
        return isProjectTextFile(path)
            ? {
                path,
                readText: async () => (await fetchOk(fetcher, url)).text(),
                writeText: async text => { await fetchOk(fetcher, url, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                    body: text
                }); }
            }
            : { path, resourceUrl: url };
    };
    return {
        name: projectName,
        rootPath: manifest.rootPath,
        files: manifest.files.map(createFile),
        operations: {
            createTextFile: async (path, text) => {
                await fetchOk(fetcher, remoteFileUrl(baseUrl, path), {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                    body: text
                });
                return createFile(path);
            },
            deleteFile: async path => { await fetchOk(fetcher, remoteFileUrl(baseUrl, path), { method: 'DELETE' }); }
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
