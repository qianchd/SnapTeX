import { createServer } from 'node:http';
import { createReadStream, existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const defaultRoot = resolve(process.argv[2] ?? join(repoRoot, 'dist-web'));
const defaultPort = Number(process.env.PORT || 3000);
const defaultHost = process.env.HOST || '127.0.0.1';
const projectFilePattern = /\.(?:tex|bib|sty|cls|bst|txt|pdf|png|jpe?g|gif|svg|webp|bmp)$/i;
const projectTextFilePattern = /\.(?:tex|bib|sty|cls|bst|txt)$/i;
const projectApiPrefix = '/api/project';
const maxWriteBytes = 10 * 1024 * 1024;

const contentTypes = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.ico', 'image/x-icon'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.pdf', 'application/pdf'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
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

function resolveProjectFile(root, pathname) {
    try {
        const relativePath = decodeURIComponent(pathname).replace(/^\/+/, '');
        const candidate = resolve(root, relativePath);
        if (!isWithin(root, candidate) || !projectFilePattern.test(candidate) || !existsSync(candidate)) {
            return undefined;
        }
        const realPath = realpathSync(candidate);
        return isWithin(root, realPath) && lstatSync(realPath).isFile() ? realPath : undefined;
    } catch {
        return undefined;
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

async function handleProjectRequest(request, response, projectRoot) {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== projectApiPrefix && !pathname.startsWith(`${projectApiPrefix}/`)) {
        return false;
    }
    if (!projectRoot) {
        response.writeHead(404);
        response.end('Remote project API is disabled.');
        return true;
    }

    if (pathname === `${projectApiPrefix}/manifest` && request.method === 'GET') {
        const files = listProjectFiles(projectRoot);
        const rootPath = chooseProjectRootPath(files);
        if (!rootPath) {
            sendJson(response, 409, { error: 'No TeX root file found.' });
        } else {
            sendJson(response, 200, { rootPath, files });
        }
        return true;
    }

    const filePrefix = `${projectApiPrefix}/files/`;
    const filePath = pathname.startsWith(filePrefix)
        ? resolveProjectFile(projectRoot, pathname.slice(filePrefix.length))
        : undefined;
    if (!filePath) {
        response.writeHead(404);
        response.end('Not found');
        return true;
    }
    if (request.method === 'GET') {
        response.writeHead(200, {
            'Content-Type': contentTypes.get(extname(filePath)) ?? 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        createReadStream(filePath).pipe(response);
        return true;
    }
    if (request.method === 'PUT' && projectTextFilePattern.test(filePath)) {
        await writeFile(filePath, await readTextBody(request), 'utf8');
        response.writeHead(204);
        response.end();
        return true;
    }

    response.writeHead(405, { Allow: projectTextFilePattern.test(filePath) ? 'GET, PUT' : 'GET' });
    response.end('Method not allowed');
    return true;
}

export function createSnapTeXWebServer(options = {}) {
    const root = resolve(options.root ?? defaultRoot);
    const indexPath = options.indexPath ?? defaultIndexPath(root);
    const projectRoot = options.projectRoot ? realpathSync(resolve(options.projectRoot)) : undefined;
    return createServer((request, response) => void (async () => {
        if (await handleProjectRequest(request, response, projectRoot)) {
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
        if (!response.headersSent) {
            sendJson(response, error.message === 'Request body is too large.' ? 413 : 500, { error: error.message });
        } else {
            response.destroy(error);
        }
    }));
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
    const projectRoot = process.env.SNAPTEX_PROJECT_ROOT;
    const server = createSnapTeXWebServer({ projectRoot });
    server.listen(defaultPort, defaultHost, () => {
        console.log(`[SnapTeX Web] http://${defaultHost}:${defaultPort}/`);
        if (projectRoot) {
            console.log(`[SnapTeX Web] Project API: ${resolve(projectRoot)}`);
        }
    });
}
