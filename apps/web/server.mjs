import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebSessionAuth } from './web-session.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const defaultRoot = resolve(process.argv[2] ?? join(repoRoot, 'dist-web'));
const defaultPort = Number(process.env.PORT || 3000);
const defaultHost = process.env.HOST || '127.0.0.1';
const projectFilePattern = /\.(?:tex|bib|sty|cls|bst|md|txt|pdf|png|jpe?g|gif|svg|webp|bmp)$/i;
const projectTextFilePattern = /\.(?:tex|bib|sty|cls|bst|md|txt)$/i;
const projectApiPrefix = '/api/projects';
const projectNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const maxWriteBytes = 10 * 1024 * 1024;

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
    ['.gz', 'application/gzip']
]);

function defaultIndexPath(root) {
    return root === repoRoot ? '/apps/web/index.html' : '/index.html';
}

function resolveRequestPath(root, url, indexPath = defaultIndexPath(root)) {
    try {
        const parsed = new URL(url, 'http://localhost');
        const pathname = parsed.pathname === '/' ? indexPath : parsed.pathname;
        const filePath = resolve(root, decodeURIComponent(pathname).replace(/^\/+/, ''));
        return filePath === root || filePath.startsWith(`${root}${sep}`) ? filePath : undefined;
    } catch {
        return undefined;
    }
}

function isWithin(root, path) {
    return path === root || path.startsWith(`${root}${sep}`);
}

function hasDeniedPathSegment(pathname) {
    return pathname.split(/[\\/]+/).some(part => !part || part === '.' || part === '..' || part === 'node_modules' || part.startsWith('.'));
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

function sendJson(response, status, value) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify(value));
}

async function readTextBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > maxWriteBytes) {
            throw new Error('Request body is too large.');
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
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
        sendJson(response, 201, { rootPath: '/main.tex', files: ['/main.tex'] });
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
        const files = listProjectFiles(projectRoot);
        const rootPath = chooseProjectRootPath(files);
        if (!rootPath) {
            sendJson(response, 409, { error: 'No TeX root file found.' });
        } else {
            sendJson(response, 200, { rootPath, files });
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
            await writeFile(newFilePath, await readTextBody(request), { encoding: 'utf8', flag: 'wx' });
        } catch (error) {
            if (error?.code === 'EEXIST') {
                sendJson(response, 409, { error: 'File already exists.' });
                return true;
            }
            throw error;
        }
        response.writeHead(201);
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
        if (extname(filePath).toLowerCase() === '.svg') {
            response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        }
        response.writeHead(200, {
            'Content-Type': contentTypes.get(extname(filePath)) ?? 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        createReadStream(filePath).pipe(response);
        return true;
    }
    if (request.method === 'PUT' && projectTextFilePattern.test(filePath)) {
        await replaceTextFile(filePath, await readTextBody(request));
        response.writeHead(204);
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
    const root = resolve(options.root ?? defaultRoot);
    const indexPath = options.indexPath ?? defaultIndexPath(root);
    const projectsRoot = options.projectsRoot ? realpathSync(resolve(options.projectsRoot)) : undefined;
    const auth = createWebSessionAuth(options.auth);
    const server = createServer((request, response) => void (async () => {
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('X-Frame-Options', 'DENY');
        response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (pathname === '/healthz') {
            sendJson(response, 200, { status: 'ok' });
            return;
        }
        if (await auth.handle(request, response, pathname)) return;
        const isProjectRequest = pathname === projectApiPrefix || pathname.startsWith(`${projectApiPrefix}/`);
        if (isProjectRequest && !auth.authorize(request, response)) return;
        if (await handleProjectRequest(request, response, projectsRoot)) {
            return;
        }
        const filePath = resolveRequestPath(root, request.url ?? '/', indexPath);
        if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
            response.writeHead(404);
            response.end('Not found');
            return;
        }

        response.writeHead(200, {
            'Content-Type': contentTypes.get(extname(filePath)) ?? 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        createReadStream(filePath).pipe(response);
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
    server.on('close', auth.clear);
    return server;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
    const projectsRoot = process.env.SNAPTEX_PROJECTS_ROOT;
    const publicOrigin = process.env.SNAPTEX_PUBLIC_ORIGIN;
    const username = process.env.SNAPTEX_AUTH_USERNAME;
    const password = process.env.SNAPTEX_AUTH_PASSWORD;
    if (process.env.NODE_ENV === 'production' && !['127.0.0.1', '::1', 'localhost'].includes(defaultHost)) {
        throw new Error('Production SnapTeX Server must listen on a loopback host behind an HTTPS reverse proxy.');
    }
    if (projectsRoot && process.env.NODE_ENV === 'production' && publicOrigin && new URL(publicOrigin).protocol !== 'https:') {
        throw new Error('Production SNAPTeX_PUBLIC_ORIGIN must use HTTPS.');
    }
    if (projectsRoot && process.env.NODE_ENV === 'production' && (!username || !password || password.length < 16 || !publicOrigin)) {
        throw new Error('Production remote projects require SNAPTeX_AUTH_USERNAME, SNAPTeX_AUTH_PASSWORD (16+ characters), and SNAPTeX_PUBLIC_ORIGIN.');
    }
    const auth = username && password && publicOrigin ? {
        username,
        password,
        publicOrigin,
        publicPath: process.env.SNAPTEX_PUBLIC_PATH
    } : undefined;
    const server = createSnapTeXWebServer({ projectsRoot, auth });
    server.listen(defaultPort, defaultHost, () => {
        console.log(`[SnapTeX Web] http://${defaultHost}:${defaultPort}/`);
        if (projectsRoot) {
            console.log(`[SnapTeX Web] Projects API: ${resolve(projectsRoot)}`);
        }
    });
}
