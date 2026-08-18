import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const rootDir = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const defaultOutDir = resolve(rootDir, 'dist-web');
const hashLength = 12;
const minimumCompressionBytes = 1024;
const compressibleAssetPattern = /\.(?:css|html|js|json|mjs|svg|tex|bib|md|txt|wasm|webmanifest)$/i;
const serviceWorkerGroupNames = ['core', 'katex', 'pdf', 'tikz', 'demo'];

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
    ['apps/web/index.html', 'index.html'],
    ['apps/web/manifest.webmanifest', 'manifest.webmanifest'],
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

function outputAssetPath(path) {
    for (const [source, destination] of staticFiles) {
        const prefix = `/${source}`;
        if (path === prefix || path.startsWith(`${prefix}/`)) {
            return `${destination}${path.slice(prefix.length)}`;
        }
    }
    return path;
}

function makeStaticIndex(source, deploymentMode, assetHashes) {
    return source
        .replace('data-deployment-mode="static"', `data-deployment-mode="${deploymentMode}"`)
        .replace('</body>', '    <script src="register-service-worker.js"></script>\n</body>')
        .replace(/\b(href|src|data-[\w-]+)="([^"]+)"/g, (_match, attribute, path) => {
            const outputPath = outputAssetPath(path);
            const hash = (attribute === 'href' || attribute === 'src') ? assetHashes[outputPath] : undefined;
            return `${attribute}="${hash ? `${outputPath}?v=${hash}` : outputPath}"`;
        });
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

function hashContent(content) {
    return createHash('sha256').update(content).digest('hex').slice(0, hashLength);
}

function versionedAsset(asset, assetHashes) {
    const hash = assetHashes[asset];
    if (!hash) throw new Error(`Missing static asset hash: ${asset}`);
    return `${asset}?v=${hash}`;
}

function assetHashesFor(outDir, assets) {
    return Object.fromEntries(assets.map(asset => [asset, hashContent(readFileSync(join(outDir, asset)))]));
}

function assetGroup(asset) {
    if (asset.startsWith('media/vendor/katex/')) return 'katex';
    if (asset.startsWith('media/vendor/tikzjax/')) return 'tikz';
    if (asset.startsWith('media/vendor/pdfjs/')) return 'pdf';
    if (asset.startsWith('demo/')) return 'demo';
    return 'core';
}

function serviceWorkerGroups(assets, assetHashes) {
    const groupedAssets = new Map(serviceWorkerGroupNames.map(name => [name, []]));
    for (const asset of assets) {
        const name = assetGroup(asset);
        groupedAssets.get(name).push(`./${versionedAsset(asset, assetHashes)}`);
    }
    return [...groupedAssets]
        .filter(([, versionedAssets]) => versionedAssets.length > 0)
        .map(([name, versionedAssets]) => ({
            name,
            version: hashContent(versionedAssets.join('\0')),
            assets: versionedAssets
        }));
}

function serviceWorkerSource(groups) {
    return [
        "const CACHE_PREFIX = `snaptex-web:${self.registration.scope}:`;",
        `const GROUPS = ${JSON.stringify(groups, null, 4)};`,
        "const cacheName = group => `${CACHE_PREFIX}${group.name}:${group.version}`;",
        'const ACTIVE_CACHES = GROUPS.map(cacheName);',
        "const CORE_CACHE = cacheName(GROUPS.find(group => group.name === 'core'));",
        "const INDEX_ASSET = GROUPS.find(group => group.name === 'core').assets.find(asset => asset.startsWith('./index.html?'));",
        'const APP_PATH = new URL(self.registration.scope).pathname;',
        '',
        "self.addEventListener('install', event => {",
        '    event.waitUntil((async () => {',
        '        for (const group of GROUPS) {',
        '            const cache = await caches.open(cacheName(group));',
        '            const marker = `./__snaptex_complete__?group=${group.name}&v=${group.version}`;',
        '            if (await cache.match(marker)) continue;',
        '            await cache.addAll(group.assets);',
        "            await cache.put(marker, new Response('ready'));",
        '        }',
        '        await self.skipWaiting();',
        '    })());',
        '});',
        '',
        "self.addEventListener('activate', event => {",
        '    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && !ACTIVE_CACHES.includes(key)).map(key => caches.delete(key)))).then(() => self.clients.claim()));',
        '});',
        '',
        'async function matchActive(request) {',
        '    for (const name of ACTIVE_CACHES) {',
        '        const cached = await (await caches.open(name)).match(request, { ignoreSearch: true });',
        '        if (cached) return cached;',
        '    }',
        '}',
        '',
        'async function navigate(request) {',
        '    const cached = await (await caches.open(CORE_CACHE)).match(INDEX_ASSET);',
        '    return cached || fetch(request);',
        '}',
        '',
        "self.addEventListener('fetch', event => {",
        '    const url = new URL(event.request.url);',
        "    if (event.request.method !== 'GET' || url.origin !== self.location.origin || /^\\/(?:api|web-auth)(?:\\/|$)/.test(url.pathname)) {",
        '        return;',
        '    }',
        '',
        "    if (event.request.mode === 'navigate') {",
        '        event.respondWith(url.pathname === APP_PATH || url.pathname === `${APP_PATH}index.html`',
        '            ? navigate(event.request)',
        '            : fetch(event.request).catch(() => matchActive(event.request)));',
        '        return;',
        '    }',
        '',
        '    event.respondWith(matchActive(event.request).then(cached => cached || fetch(event.request)));',
        '});',
        ''
    ].join('\n');
}

function writeManifest(outDir, assetHashes) {
    writeFileSync(join(outDir, 'asset-manifest.json'), `${JSON.stringify({ version: 1, assets: assetHashes }, null, 2)}\n`);
}

export function writeCompressedAssets(outDir, assets) {
    for (const asset of assets) {
        if (!compressibleAssetPattern.test(asset)) continue;
        const path = join(outDir, asset);
        const content = readFileSync(path);
        if (content.length < minimumCompressionBytes) continue;
        writeFileSync(`${path}.br`, brotliCompressSync(content, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
        }));
        writeFileSync(`${path}.gz`, gzipSync(content, { level: 9 }));
    }
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

    const copiedAssets = listFiles(outDir);
    const copiedAssetHashes = assetHashesFor(outDir, copiedAssets);
    const manifestPath = join(outDir, 'manifest.webmanifest');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.icons = manifest.icons.map(icon => {
        const path = outputAssetPath(icon.src);
        return { ...icon, src: versionedAsset(path, copiedAssetHashes) };
    });
    const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(manifestPath, manifestSource);
    copiedAssetHashes['manifest.webmanifest'] = hashContent(manifestSource);
    const indexPath = join(outDir, 'index.html');
    const indexSource = makeStaticIndex(readFileSync(indexPath, 'utf8'), deploymentMode, copiedAssetHashes);
    writeFileSync(indexPath, indexSource);
    copiedAssetHashes['index.html'] = hashContent(indexSource);
    writeFileSync(join(outDir, '.nojekyll'), '');

    const serviceWorker = serviceWorkerSource(serviceWorkerGroups(copiedAssets, copiedAssetHashes));
    writeFileSync(join(outDir, 'service-worker.js'), serviceWorker);
    copiedAssetHashes['service-worker.js'] = hashContent(serviceWorker);
    writeManifest(outDir, copiedAssetHashes);
    if (deploymentMode === 'server') {
        writeCompressedAssets(outDir, [...copiedAssets, 'service-worker.js', 'asset-manifest.json']);
    }
    return { outDir };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const deploymentMode = process.argv.includes('--server') ? 'server' : 'static';
    const { outDir } = buildStaticWeb({ outDir: process.env.SNAPTEX_WEB_OUT_DIR, deploymentMode });
    if (deploymentMode === 'static') {
        copyPath(join(rootDir, 'docs/.vitepress/dist'), join(outDir, 'docs'));
    }
    console.log(`[SnapTeX Web] ${deploymentMode} PWA written to ${outDir}`);
}
