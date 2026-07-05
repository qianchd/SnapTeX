import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const defaultPort = Number(process.env.PORT || 5178);

const contentTypes = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.wasm', 'application/wasm'],
    ['.gz', 'application/gzip']
]);

function resolveRequestPath(root, url, port = defaultPort) {
    const parsed = new URL(url, `http://localhost:${port}`);
    const pathname = parsed.pathname === '/' ? '/apps/web/index.html' : parsed.pathname;
    const filePath = normalize(join(root, decodeURIComponent(pathname)));
    return filePath.startsWith(root) ? filePath : undefined;
}

export function createSnapTeXWebServer(options = {}) {
    const root = resolve(options.root ?? defaultRoot);
    const port = Number(options.port ?? defaultPort);
    return createServer((request, response) => {
        const filePath = resolveRequestPath(root, request.url ?? '/', port);
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
    });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
    const server = createSnapTeXWebServer();
    server.listen(defaultPort, () => {
        console.log(`[SnapTeX Web] http://localhost:${defaultPort}/apps/web/index.html`);
    });
}
