import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { readRequestText, sendJson } from './http-utils.mjs';
import { createWebSessionAuth } from './web-session.mjs';

const repoRoot = realpathSync(resolve(fileURLToPath(new URL('../..', import.meta.url))));
const defaultRoot = resolve(process.argv[2] ?? join(repoRoot, 'dist-web'));
const defaultPort = Number(process.env.PORT || 3000);
const defaultHost = process.env.HOST || 'localhost';
const projectFilePattern = /\.(?:tex|bib|sty|cls|bst|md|txt|pdf|png|jpe?g|gif|svg|webp|bmp)$/i;
const projectTextFilePattern = /\.(?:tex|bib|sty|cls|bst|md|txt)$/i;
const projectApiPrefix = '/api/projects';
const projectNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const maxWriteBytes = 10 * 1024 * 1024;
const sourceWebFiles = new Set([
    '/apps/web/index.html',
    '/apps/web/manifest.webmanifest',
    '/apps/web/preview-bridge.js',
    '/apps/web/web.css'
]);
const sourceServiceWorker = `
const CACHE_PREFIX = \`snaptex-web:\${self.registration.scope}:\`;
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX)).map(key => caches.delete(key)));
    await self.clients.claim();
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    await Promise.all(clients.map(client => client.navigate(client.url)));
})()));
`;

const contentTypes = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.ico', 'image/x-icon'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.bmp', 'image/bmp'],
    ['.gif', 'image/gif'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.pdf', 'application/pdf'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.webp', 'image/webp'],
    ['.webmanifest', 'application/manifest+json; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.wasm', 'application/wasm'],
    ['.gz', 'application/gzip'],
    ['.tex', 'text/plain; charset=utf-8'],
    ['.bib', 'text/plain; charset=utf-8'],
    ['.sty', 'text/plain; charset=utf-8'],
    ['.cls', 'text/plain; charset=utf-8'],
    ['.bst', 'text/plain; charset=utf-8'],
    ['.md', 'text/markdown; charset=utf-8'],
    ['.txt', 'text/plain; charset=utf-8']
]);
const compressibleAssetPattern = /\.(?:css|html|js|json|mjs|svg|tex|bib|md|txt|wasm|webmanifest)$/i;

function defaultIndexPath(root) {
    return root === repoRoot ? '/apps/web/index.html' : '/index.html';
}

function resolveRequestPath(root, url, indexPath = defaultIndexPath(root)) {
    try {
        const parsed = new URL(url, 'http://localhost');
        const pathname = parsed.pathname === '/' ? indexPath : parsed.pathname;
        const relativePath = decodeURIComponent(pathname).replace(/^\/+/, '');
        const publicPath = `/${relativePath.replace(/\\/g, '/')}`;
        if (root === repoRoot && (hasDeniedPathSegment(relativePath) ||
            (!sourceWebFiles.has(publicPath) && !publicPath.startsWith('/apps/web/dist/') &&
                !publicPath.startsWith('/media/') && !publicPath.startsWith('/demo/')))) return undefined;
        let candidate = resolve(root, relativePath);
        if (!isWithin(root, candidate)) {
            return undefined;
        }
        if (existsSync(candidate) && !lstatSync(candidate).isSymbolicLink() && statSync(candidate).isDirectory()) {
            candidate = join(candidate, 'index.html');
        } else if (!existsSync(candidate) && !extname(candidate)) {
            candidate += '.html';
        }
        if (!existsSync(candidate) || lstatSync(candidate).isSymbolicLink()) { return undefined; }
        const filePath = realpathSync(candidate);
        return isWithin(root, filePath) ? filePath : undefined;
    } catch {
        return undefined;
    }
}

function isWithin(root, path) {
    return path === root || path.startsWith(`${root}${sep}`);
}

function hasDeniedPathSegment(pathname) {
    return pathname.split(/[\\/]+/).some(part => !part || part === '.' || part === '..' ||
        part === 'node_modules' || part.startsWith('.') || /[\u0000-\u001f\u007f]/.test(part));
}

function isPermissionError(error) {
    return error?.code === 'EACCES' || error?.code === 'EPERM';
}

function listProjectFiles(root, directory = root) {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name.startsWith('.')) {
            continue;
        }
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...listProjectFiles(root, path));
        } else if (entry.isFile() && projectFilePattern.test(entry.name)) {
            files.push(`/${relative(root, path).split(sep).join('/')}`);
        }
    }
    return files.sort((a, b) => a.localeCompare(b));
}

function chooseProjectRootPath(files) {
    const texFiles = files.filter(path => /\.tex$/i.test(path));
    return texFiles.find(path => /\/main\.tex$/i.test(path))
        ?? texFiles.find(path => /\/root\.tex$/i.test(path))
        ?? texFiles[0];
}

function projectManifest(projectRoot) {
    const files = listProjectFiles(projectRoot);
    return {
        rootPath: chooseProjectRootPath(files),
        files,
        revisions: Object.fromEntries(files
            .filter(path => projectTextFilePattern.test(path))
            .map(path => {
                const stats = statSync(join(projectRoot, path.slice(1)), { bigint: true });
                return [path, `${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`];
            }))
    };
}

function resolveProjectFile(root, pathname, requireExisting = true) {
    try {
        const relativePath = decodeURIComponent(pathname).replace(/^\/+/, '');
        const candidate = resolve(root, relativePath);
        if (!relativePath || hasDeniedPathSegment(relativePath) || !isWithin(root, candidate) || !projectFilePattern.test(candidate)) {
            return undefined;
        }
        if (!existsSync(candidate)) {
            return requireExisting ? undefined : candidate;
        }
        if (lstatSync(candidate).isSymbolicLink()) {
            return undefined;
        }
        const realPath = realpathSync(candidate);
        return isWithin(root, realPath) && lstatSync(realPath).isFile() ? realPath : undefined;
    } catch {
        return undefined;
    }
}

function isProjectName(name) {
    return projectNamePattern.test(name) && name !== '.' && name !== '..';
}

function resolveProjectDirectory(projectsRoot, name) {
    if (!isProjectName(name)) {
        return undefined;
    }
    const candidate = resolve(projectsRoot, name);
    if (!isWithin(projectsRoot, candidate) || !existsSync(candidate) || lstatSync(candidate).isSymbolicLink()) {
        return undefined;
    }
    const realPath = realpathSync(candidate);
    return isWithin(projectsRoot, realPath) && lstatSync(realPath).isDirectory() ? realPath : undefined;
}

async function ensureProjectParent(projectRoot, filePath) {
    const relativePath = relative(projectRoot, filePath);
    let directory = projectRoot;
    for (const part of relativePath.split(sep).slice(0, -1)) {
        directory = join(directory, part);
        if (!existsSync(directory)) {
            await mkdir(directory);
        } else if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
            throw new Error('Project file parent is not a directory.');
        }
    }
}

async function replaceTextFile(filePath, text) {
    const temporaryPath = join(dirname(filePath), `.snaptex-${randomBytes(12).toString('hex')}.tmp`);
    try {
        await writeFile(temporaryPath, text, { encoding: 'utf8', flag: 'wx' });
        await rename(temporaryPath, filePath);
    } finally {
        await unlink(temporaryPath).catch(() => undefined);
    }
}

function loadAssetHashes(root) {
    const manifestPath = join(root, 'asset-manifest.json');
    if (!existsSync(manifestPath)) return {};
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest?.version !== 1 || !manifest.assets || typeof manifest.assets !== 'object' ||
        Array.isArray(manifest.assets) || Object.values(manifest.assets).some(hash =>
            typeof hash !== 'string' || !/^[a-f0-9]{12}$/.test(hash))) {
        throw new Error(`Invalid static asset manifest: ${manifestPath}`);
    }
    return manifest.assets;
}

function fileVersion(filePath, root, assetHashes) {
    const asset = root ? relative(root, filePath).split(sep).join('/') : '';
    if (Object.hasOwn(assetHashes, asset)) return { asset, hash: assetHashes[asset] };
    const stat = statSync(filePath);
    return { asset, hash: `${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}` };
}

function acceptedEncodings(request) {
    const value = request.headers['accept-encoding'];
    if (!value) return [];
    const qualities = new Map(value.split(',').map(part => {
        const [name, ...parameters] = part.trim().toLowerCase().split(';');
        const quality = parameters.find(parameter => parameter.trim().startsWith('q='));
        return [name, quality ? Number(quality.split('=')[1]) : 1];
    }));
    const quality = encoding => qualities.get(encoding) ?? qualities.get('*') ?? 0;
    return ['br', 'gzip'].filter(encoding => quality(encoding) > 0)
        .sort((left, right) => quality(right) - quality(left));
}

function etagMatches(value, etag) {
    const normalizedEtag = etag.replace(/^W\//, '');
    return value === '*' || value?.split(',').some(candidate => candidate.trim().replace(/^W\//, '') === normalizedEtag);
}

function requestHasEtag(request, etag) {
    return etagMatches(request.headers['if-none-match'], etag);
}

function textEtag(content) {
    return `"${createHash('sha256').update(content).digest('base64url')}"`;
}

async function sendProjectTextFile(request, response, filePath) {
    const content = await readFile(filePath);
    const headers = {
        'Content-Type': contentTypes.get(extname(filePath).toLowerCase()) ?? 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': String(content.length),
        ETag: textEtag(content)
    };
    if (requestHasEtag(request, headers.ETag)) {
        response.writeHead(304, headers);
        response.end();
        return;
    }
    response.writeHead(200, headers);
    response.end(content);
}

async function sendFile(request, response, filePath, options = {}) {
    const { headOnly = false, deploymentMode, root, assetHashes = {}, staticAsset = false } = options;
    const extension = extname(filePath).toLowerCase();
    let content;
    let asset = '';
    let hash = '';
    if (staticAsset) ({ asset, hash } = fileVersion(filePath, root, assetHashes));
    if (extension === '.html' && deploymentMode) {
        const source = readFileSync(filePath, 'utf8');
        const transformed = source.replace(/data-deployment-mode="(?:static|server)"/, `data-deployment-mode="${deploymentMode}"`);
        if (transformed !== source) {
            content = Buffer.from(transformed);
            hash = createHash('sha256').update(content).digest('hex').slice(0, 12);
        }
    }
    const version = staticAsset ? new URL(request.url ?? '/', 'http://localhost').searchParams.get('v') : undefined;
    const responseCacheControl = !staticAsset
        ? 'no-store'
        : extension === '.html' || asset === 'service-worker.js'
            ? 'public, no-cache, must-revalidate'
            : version === hash
                ? 'public, max-age=31536000, immutable'
                : 'public, no-cache, must-revalidate';
    const headers = {
        'Content-Type': contentTypes.get(extension) ?? 'application/octet-stream',
        'Cache-Control': responseCacheControl
    };
    if (staticAsset) headers.ETag = `W/"${hash}"`;
    if (staticAsset && compressibleAssetPattern.test(filePath)) headers.Vary = 'Accept-Encoding';
    if (extension === '.svg') {
        response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    }
    if (staticAsset && requestHasEtag(request, headers.ETag)) {
        response.writeHead(304, headers);
        response.end();
        return;
    }

    let responsePath = filePath;
    if (!content && staticAsset) {
        for (const encoding of acceptedEncodings(request)) {
            const suffix = encoding === 'br' ? '.br' : '.gz';
            if (!existsSync(`${filePath}${suffix}`)) continue;
            responsePath = `${filePath}${suffix}`;
            headers['Content-Encoding'] = encoding;
            break;
        }
    }
    headers['Content-Length'] = String(content?.length ?? statSync(responsePath).size);
    response.writeHead(200, headers);
    if (headOnly) {
        response.end();
        return;
    }
    if (content) {
        response.end(content);
        return;
    }
    await pipeline(createReadStream(responsePath), response);
}

async function handleProjectRequest(request, response, projectsRoot) {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== projectApiPrefix && !pathname.startsWith(`${projectApiPrefix}/`)) {
        return false;
    }
    if (!projectsRoot) {
        response.writeHead(404);
        response.end('Remote project API is disabled.');
        return true;
    }

    if (pathname === projectApiPrefix) {
        if (request.method === 'GET') {
            sendJson(response, 200, { status: 'ok' });
        } else {
            response.writeHead(405, { Allow: 'GET' });
            response.end('Method not allowed');
        }
        return true;
    }

    const remainder = pathname.slice(projectApiPrefix.length + 1);
    const slashIndex = remainder.indexOf('/');
    const encodedName = slashIndex < 0 ? remainder : remainder.slice(0, slashIndex);
    const route = slashIndex < 0 ? '' : remainder.slice(slashIndex + 1);
    let projectName;
    try {
        projectName = decodeURIComponent(encodedName);
    } catch {
        projectName = '';
    }
    if (!isProjectName(projectName)) {
        response.writeHead(404);
        response.end('Not found');
        return true;
    }

    let projectRoot = resolveProjectDirectory(projectsRoot, projectName);
    if (!projectRoot && route === '' && request.method === 'POST') {
        const projectPath = resolve(projectsRoot, projectName);
        try {
            await mkdir(projectPath);
        } catch (error) {
            if (error?.code === 'EEXIST') {
                sendJson(response, 409, { error: 'Project already exists.' });
                return true;
            }
            throw error;
        }
        await writeFile(join(projectPath, 'main.tex'), [
            '\\documentclass{article}',
            '\\begin{document}',
            '',
            '\\end{document}',
            ''
        ].join('\n'), 'utf8');
        sendJson(response, 201, projectManifest(projectPath));
        return true;
    }
    if (!projectRoot) {
        sendJson(response, 404, { code: 'PROJECT_NOT_FOUND', error: 'Project does not exist.' });
        return true;
    }
    if (route === '' && request.method === 'POST') {
        sendJson(response, 409, { error: 'Project already exists.' });
        return true;
    }

    if (route === 'manifest' && request.method === 'GET') {
        let manifest;
        try {
            manifest = projectManifest(projectRoot);
        } catch (error) {
            if (!isPermissionError(error)) { throw error; }
            console.error('[SnapTeX Web] Project path is unreadable:', error.path);
            sendJson(response, 503, {
                code: 'PROJECT_UNREADABLE',
                error: 'The server cannot read part of this project. Ask the administrator to repair its permissions.'
            });
            return true;
        }
        if (!manifest.rootPath) {
            sendJson(response, 409, { error: 'No TeX root file found.' });
        } else {
            sendJson(response, 200, manifest);
        }
        return true;
    }

    const filePrefix = 'files/';
    const encodedFilePath = route.startsWith(filePrefix) ? route.slice(filePrefix.length) : '';
    const filePath = encodedFilePath ? resolveProjectFile(projectRoot, encodedFilePath) : undefined;
    const newFilePath = !filePath && request.method === 'POST'
        ? resolveProjectFile(projectRoot, encodedFilePath, false)
        : undefined;
    if (newFilePath && !projectTextFilePattern.test(newFilePath)) {
        response.writeHead(415);
        response.end('Only supported text files can be created.');
        return true;
    }
    if (newFilePath) {
        await ensureProjectParent(projectRoot, newFilePath);
        try {
            await writeFile(newFilePath, await readRequestText(request, maxWriteBytes), { encoding: 'utf8', flag: 'wx' });
        } catch (error) {
            if (error?.code === 'EEXIST') {
                sendJson(response, 409, { error: 'File already exists.' });
                return true;
            }
            throw error;
        }
        response.writeHead(201, { ETag: textEtag(await readFile(newFilePath)) });
        response.end();
        return true;
    }
    if (filePath && request.method === 'POST') {
        sendJson(response, 409, { error: 'File already exists.' });
        return true;
    }
    if (!filePath) {
        response.writeHead(404);
        response.end('Not found');
        return true;
    }
    if (request.method === 'GET') {
        if (projectTextFilePattern.test(filePath)) {
            await sendProjectTextFile(request, response, filePath);
        } else {
            await sendFile(request, response, filePath);
        }
        return true;
    }
    if (request.method === 'PUT' && projectTextFilePattern.test(filePath)) {
        const currentContent = await readFile(filePath);
        const currentEtag = textEtag(currentContent);
        if (!request.headers['if-match']) {
            sendJson(response, 428, { error: 'If-Match is required when updating a project file.' });
            return true;
        }
        if (!etagMatches(request.headers['if-match'], currentEtag)) {
            response.writeHead(412, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
                'Content-Length': String(currentContent.length),
                ETag: currentEtag
            });
            response.end(currentContent);
            return true;
        }
        const text = await readRequestText(request, maxWriteBytes);
        await replaceTextFile(filePath, text);
        response.writeHead(204, { ETag: textEtag(text) });
        response.end();
        return true;
    }
    if (request.method === 'DELETE' && projectTextFilePattern.test(filePath)) {
        const relativeFilePath = `/${relative(projectRoot, filePath).split(sep).join('/')}`;
        if (/\.tex$/i.test(relativeFilePath)) {
            const remainingTexFiles = listProjectFiles(projectRoot)
                .filter(path => path !== relativeFilePath && /\.tex$/i.test(path));
            if (remainingTexFiles.length === 0) {
                sendJson(response, 409, { error: 'The project must keep at least one TeX root file.' });
                return true;
            }
        }
        if (!existsSync(filePath)) {
            response.writeHead(404);
            response.end('Not found');
            return true;
        }
        await unlink(filePath);
        response.writeHead(204);
        response.end();
        return true;
    }

    response.writeHead(405, { Allow: projectTextFilePattern.test(filePath) ? 'GET, PUT, DELETE' : 'GET' });
    response.end('Method not allowed');
    return true;
}

export function createSnapTeXWebServer(options = {}) {
    const root = realpathSync(resolve(options.root ?? defaultRoot));
    const indexPath = options.indexPath ?? defaultIndexPath(root);
    const indexFilePath = resolveRequestPath(root, indexPath, indexPath);
    const assetHashes = loadAssetHashes(root);
    const projectsRoot = options.projectsRoot ? realpathSync(resolve(options.projectsRoot)) : undefined;
    if (projectsRoot && !options.auth) {
        throw new Error('Remote projects require authentication.');
    }
    if (projectsRoot && (isWithin(root, projectsRoot) || isWithin(projectsRoot, root))) {
        throw new Error('Static assets and remote projects require separate directories.');
    }
    const auth = createWebSessionAuth(options.auth);
    const server = createServer((request, response) => void (async () => {
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('X-Frame-Options', 'DENY');
        response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (pathname === '/healthz') {
            if (request.method === 'GET') {
                sendJson(response, 200, { status: 'ok' });
            } else if (request.method === 'HEAD') {
                response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
                response.end();
            } else {
                response.writeHead(405, { Allow: 'GET, HEAD' });
                response.end('Method not allowed');
            }
            return;
        }
        if (await auth.handle(request, response, pathname)) return;
        const isProjectRequest = pathname === projectApiPrefix || pathname.startsWith(`${projectApiPrefix}/`);
        if (isProjectRequest && !auth.authorize(request, response)) return;
        if (await handleProjectRequest(request, response, projectsRoot)) {
            return;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { Allow: 'GET, HEAD' });
            response.end('Method not allowed');
            return;
        }
        if (root === repoRoot && pathname === '/service-worker.js') {
            response.writeHead(200, {
                'Content-Type': 'text/javascript; charset=utf-8',
                'Cache-Control': 'no-store',
                'Service-Worker-Allowed': '/'
            });
            response.end(request.method === 'HEAD' ? undefined : sourceServiceWorker);
            return;
        }
        const filePath = resolveRequestPath(root, request.url ?? '/', indexPath);
        if (!filePath || !statSync(filePath).isFile()) {
            response.writeHead(404);
            response.end('Not found');
            return;
        }

        await sendFile(request, response, filePath, {
            headOnly: request.method === 'HEAD',
            deploymentMode: filePath === indexFilePath ? (projectsRoot ? 'server' : 'static') : undefined,
            root,
            assetHashes,
            staticAsset: true
        });
    })().catch(error => {
        console.error('[SnapTeX Web] Request failed:', error);
        if (!response.headersSent) {
            sendJson(response, error.message === 'Request body is too large.' ? 413 : 500, {
                error: error.message === 'Request body is too large.' ? error.message : 'Internal server error.'
            });
        } else {
            response.destroy(error);
        }
    }));
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    server.maxHeadersCount = 100;
    server.on('close', auth.clear);
    return server;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
    const projectsRoot = process.env.SNAPTEX_PROJECTS_ROOT;
    const publicOrigin = process.env.SNAPTEX_PUBLIC_ORIGIN;
    const username = process.env.SNAPTEX_AUTH_USERNAME;
    const password = process.env.SNAPTEX_AUTH_PASSWORD;
    if (projectsRoot && !['127.0.0.1', '::1', 'localhost'].includes(defaultHost)) {
        throw new Error('SnapTeX remote projects must listen on a loopback host behind an HTTPS reverse proxy.');
    }
    if (projectsRoot && (!username || !password || !publicOrigin)) {
        throw new Error('Remote projects require SNAPTeX_AUTH_USERNAME, SNAPTeX_AUTH_PASSWORD (16+ characters), and SNAPTeX_PUBLIC_ORIGIN.');
    }
    const auth = username && password && publicOrigin ? {
        username,
        password,
        publicOrigin,
        publicPath: process.env.SNAPTEX_PUBLIC_PATH,
        sessionFile: process.env.SNAPTEX_AUTH_SESSION_FILE || (process.env.STATE_DIRECTORY
            ? join(process.env.STATE_DIRECTORY, 'sessions.json')
            : undefined)
    } : undefined;
    const server = createSnapTeXWebServer({ projectsRoot, auth });
    server.listen(defaultPort, defaultHost, () => {
        console.log(`[SnapTeX Web] http://${defaultHost}:${defaultPort}/`);
        if (projectsRoot) {
            console.log(`[SnapTeX Web] Projects API: ${resolve(projectsRoot)}`);
        }
    });
}
