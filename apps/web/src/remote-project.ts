import { normalizeBrowserPath, type BrowserProjectFile } from '../../standalone/src/browser-file-provider';
import { isProjectFile, isProjectTextFile, isTexFile } from '../../standalone/src/browser-project';

interface RemoteProjectManifest {
    rootPath: string;
    files: string[];
}

export interface RemoteProject {
    rootPath: string;
    files: BrowserProjectFile[];
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
    const response = await fetcher(url, init);
    if (!response.ok) {
        throw new Error(`${init?.method ?? 'GET'} ${url} failed: ${response.status}`);
    }
    return response;
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

/** Maps the optional SnapTeX HTTP project API onto the shared browser project model. */
export async function loadRemoteProject(apiBaseUrl: string, fetcher: typeof fetch = fetch): Promise<RemoteProject> {
    const baseUrl = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
    const manifest = readManifest(await (await fetchOk(fetcher, new URL('manifest', baseUrl).toString())).json());
    return {
        rootPath: manifest.rootPath,
        files: manifest.files.map(path => {
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
        })
    };
}
