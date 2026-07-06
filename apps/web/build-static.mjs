import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const defaultOutDir = resolve(rootDir, 'dist-web');

const staticFiles = [
    ['demo', 'demo'],
    ['media/vendor', 'media/vendor'],
    ['media/icon.png', 'media/icon.png'],
    ['media/preview-style.css', 'media/preview-style.css'],
    ['media/webview-main.js', 'media/webview-main.js'],
    ['media/webview-pdf.js', 'media/webview-pdf.js'],
    ['apps/web/web.css', 'web.css'],
    ['apps/web/dist/web-main.js', 'web-main.js'],
    ['apps/web/manifest.webmanifest', 'manifest.webmanifest']
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

function readSourceIndex(root) {
    return readFileSync(join(root, 'apps/web/index.html'), 'utf8');
}

function makeStaticIndex(source) {
    return source
        .replaceAll('href="/media/icon.png"', 'href="media/icon.png"')
        .replaceAll('href="/media/vendor/katex/katex.min.css"', 'href="media/vendor/katex/katex.min.css"')
        .replaceAll('href="/media/preview-style.css"', 'href="media/preview-style.css"')
        .replaceAll('href="/apps/web/web.css"', 'href="web.css"')
        .replace('</head>', [
            '    <link rel="manifest" href="manifest.webmanifest">',
            '    <meta name="theme-color" content="#2563eb">',
            '</head>'
        ].join('\n'))
        .replaceAll('data-tikz-jax-js-uri="/media/vendor/tikzjax/tikzjax.js"', 'data-tikz-jax-js-uri="media/vendor/tikzjax/tikzjax.js"')
        .replaceAll('data-tikz-jax-css-uri="/media/vendor/tikzjax/fonts.css"', 'data-tikz-jax-css-uri="media/vendor/tikzjax/fonts.css"')
        .replaceAll('data-pdf-js-uri="/media/vendor/pdfjs/pdf.mjs"', 'data-pdf-js-uri="media/vendor/pdfjs/pdf.mjs"')
        .replaceAll('data-pdf-worker-uri="/media/vendor/pdfjs/pdf.worker.mjs"', 'data-pdf-worker-uri="media/vendor/pdfjs/pdf.worker.mjs"')
        .replaceAll('src="/media/icon.png"', 'src="media/icon.png"')
        .replaceAll('src="/media/webview-main.js"', 'src="media/webview-main.js"')
        .replaceAll('src="/media/webview-pdf.js"', 'src="media/webview-pdf.js"')
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

    writeFileSync(join(outDir, 'index.html'), makeStaticIndex(readSourceIndex(root)));
    writeFileSync(join(outDir, '.nojekyll'), '');
    const assets = listFiles(outDir).filter(asset => asset !== 'service-worker.js');
    writeFileSync(join(outDir, 'service-worker.js'), serviceWorkerSource(cacheNameFor(outDir, assets), assets));
    return { outDir, assets };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const { outDir } = buildStaticWeb({ outDir: process.env.SNAPTEX_WEB_OUT_DIR });
    console.log(`[SnapTeX Web] Static PWA written to ${outDir}`);
}
