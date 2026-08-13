import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const defaultOutDir = resolve(rootDir, 'dist-web');

const staticFiles = [
    ['demo', 'demo'],
    ['media/vendor', 'media/vendor'],
    ['media/favicon.ico', 'media/favicon.ico'],
    ['media/icon-32.png', 'media/icon-32.png'],
    ['media/icon.png', 'media/icon.png'],
    ['media/icon-192.png', 'media/icon-192.png'],
    ['media/icon-512.png', 'media/icon-512.png'],
    ['media/preview-style.css', 'media/preview-style.css'],
    ['media/webview-main.js', 'media/webview-main.js'],
    ['media/webview-pdf.js', 'media/webview-pdf.js'],
    ['apps/web/web.css', 'web.css'],
    ['apps/web/preview-bridge.js', 'preview-bridge.js'],
    ['apps/web/register-service-worker.js', 'register-service-worker.js'],
    ['apps/web/dist/web-main.js', 'web-main.js']
];

function copyPath(source, destination) {
    if (!existsSync(source)) {
        throw new Error(`Missing static web asset: ${source}`);
    }
    mkdirSync(dirname(destination), { recursive: true });
    if (statSync(source).isDirectory()) {
        cpSync(source, destination, { recursive: true });
    } else {
        copyFileSync(source, destination);
    }
}

function makeStaticIndex(source, deploymentMode) {
    return source
        .replace('data-deployment-mode="static"', `data-deployment-mode="${deploymentMode}"`)
        .replace(/\b(href|src|data-[\w-]+)="\/media\//g, '$1="media/')
        .replace('href="/apps/web/manifest.webmanifest"', 'href="manifest.webmanifest"')
        .replaceAll('href="/apps/web/web.css"', 'href="web.css"')
        .replaceAll('src="/apps/web/preview-bridge.js"', 'src="preview-bridge.js"')
        .replaceAll('src="/apps/web/dist/web-main.js"', 'src="web-main.js"')
        .replace('</body>', '    <script src="register-service-worker.js"></script>\n</body>');
}

function listFiles(dir, root = dir) {
    const entries = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            entries.push(...listFiles(path, root));
        } else {
            entries.push(relative(root, path).split(sep).join('/'));
        }
    }
    return entries.sort();
}

function serviceWorkerSource(cacheVersion, assets) {
    return [
        "const CACHE_PREFIX = `snaptex-web:${self.registration.scope}:`;",
        `const CACHE_NAME = CACHE_PREFIX + ${JSON.stringify(cacheVersion)};`,
        `const ASSETS = ${JSON.stringify(['./', ...assets.map(asset => `./${asset}`)], null, 4)};`,
        '',
        "self.addEventListener('install', event => {",
        '    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));',
        '});',
        '',
        "self.addEventListener('activate', event => {",
        '    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));',
        '});',
        '',
        "self.addEventListener('fetch', event => {",
        '    const url = new URL(event.request.url);',
        "    if (event.request.method !== 'GET' || url.origin !== self.location.origin || /\\/(?:api|web-auth)\\//.test(url.pathname)) {",
        '        return;',
        '    }',
        '',
        "    if (event.request.mode === 'navigate') {",
        "        event.respondWith(fetch(event.request).catch(() => caches.open(CACHE_NAME).then(cache => cache.match('./').then(cached => cached || cache.match('./index.html')))));",
        '        return;',
        '    }',
        '',
        '    event.respondWith(caches.open(CACHE_NAME).then(cache => cache.match(event.request)).then(cached => cached || fetch(event.request)));',
        '});',
        ''
    ].join('\n');
}

function cacheVersionFor(outDir, assets) {
    const hash = createHash('sha256');
    for (const asset of assets) {
        hash.update(asset);
        hash.update(readFileSync(join(outDir, asset)));
    }
    return hash.digest('hex').slice(0, 12);
}

export function buildStaticWeb(options = {}) {
    const root = resolve(options.root ?? rootDir);
    const outDir = resolve(options.outDir ?? defaultOutDir);
    const deploymentMode = options.deploymentMode ?? 'static';
    if (deploymentMode !== 'static' && deploymentMode !== 'server') {
        throw new Error(`Unsupported Web deployment mode: ${deploymentMode}`);
    }
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    for (const [source, destination] of staticFiles) {
        copyPath(join(root, source), join(outDir, destination));
    }

    writeFileSync(join(outDir, 'index.html'), makeStaticIndex(readFileSync(join(root, 'apps/web/index.html'), 'utf8'), deploymentMode));
    writeFileSync(join(outDir, 'manifest.webmanifest'), readFileSync(join(root, 'apps/web/manifest.webmanifest'), 'utf8').replaceAll('"/media/', '"media/'));
    writeFileSync(join(outDir, '.nojekyll'), '');
    const assets = listFiles(outDir).filter(asset => asset !== 'service-worker.js' && !asset.startsWith('.'));
    writeFileSync(join(outDir, 'service-worker.js'), serviceWorkerSource(cacheVersionFor(outDir, assets), assets));
    return { outDir, assets };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const deploymentMode = process.argv.includes('--server') ? 'server' : 'static';
    const { outDir } = buildStaticWeb({ outDir: process.env.SNAPTEX_WEB_OUT_DIR, deploymentMode });
    console.log(`[SnapTeX Web] ${deploymentMode} PWA written to ${outDir}`);
}
