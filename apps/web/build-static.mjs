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

function makeStaticIndex(source) {
    return source
        .replace(/\b(href|src|data-[\w-]+)="\/media\//g, '$1="media/')
        .replace('href="/apps/web/manifest.webmanifest"', 'href="manifest.webmanifest"')
        .replaceAll('href="/apps/web/web.css"', 'href="web.css"')
        .replaceAll('src="/apps/web/dist/web-main.js"', 'src="web-main.js"')
        .replace('</body>', [
            '    <script>',
            "        if ('serviceWorker' in navigator) {",
            "            window.addEventListener('load', () => {",
            "                navigator.serviceWorker.register('service-worker.js').catch(error => {",
            "                    console.warn('[SnapTeX] PWA service worker registration failed.', error);",
            '                });',
            '            });',
            '        }',
            '    </script>',
            '</body>'
        ].join('\n'));
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

function serviceWorkerSource(cacheName, assets) {
    return [
        `const CACHE_NAME = ${JSON.stringify(cacheName)};`,
        `const ASSETS = ${JSON.stringify(['./', ...assets.map(asset => `./${asset}`)], null, 4)};`,
        '',
        "self.addEventListener('install', event => {",
        '    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));',
        '});',
        '',
        "self.addEventListener('activate', event => {",
        '    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));',
        '});',
        '',
        "self.addEventListener('fetch', event => {",
        "    if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) {",
        '        return;',
        '    }',
        '',
        '    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).catch(error => {',
        "        if (event.request.mode === 'navigate') {",
        "            return caches.match('./') || caches.match('./index.html');",
        '        }',
        '        throw error;',
        '    })));',
        '});',
        ''
    ].join('\n');
}

function cacheNameFor(outDir, assets) {
    const hash = createHash('sha256');
    for (const asset of assets) {
        hash.update(asset);
        hash.update(readFileSync(join(outDir, asset)));
    }
    return `snaptex-web-${hash.digest('hex').slice(0, 12)}`;
}

export function buildStaticWeb(options = {}) {
    const root = resolve(options.root ?? rootDir);
    const outDir = resolve(options.outDir ?? defaultOutDir);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    for (const [source, destination] of staticFiles) {
        copyPath(join(root, source), join(outDir, destination));
    }

    writeFileSync(join(outDir, 'index.html'), makeStaticIndex(readFileSync(join(root, 'apps/web/index.html'), 'utf8')));
    writeFileSync(join(outDir, 'manifest.webmanifest'), readFileSync(join(root, 'apps/web/manifest.webmanifest'), 'utf8').replaceAll('"/media/', '"media/'));
    writeFileSync(join(outDir, '.nojekyll'), '');
    const assets = listFiles(outDir).filter(asset => asset !== 'service-worker.js' && !asset.startsWith('.'));
    writeFileSync(join(outDir, 'service-worker.js'), serviceWorkerSource(cacheNameFor(outDir, assets), assets));
    return { outDir, assets };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const { outDir } = buildStaticWeb({ outDir: process.env.SNAPTEX_WEB_OUT_DIR });
    console.log(`[SnapTeX Web] Static PWA written to ${outDir}`);
}
