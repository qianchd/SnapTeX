/// <reference types="mocha" />

import * as assert from 'assert';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import type { Server } from 'http';
import { basename, join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { runInNewContext } from 'vm';
import { resolvePreviewAssetUri } from '../webview/bridge';

type WebServerModule = {
    createSnapTeXWebServer(options: { root: string; indexPath?: string }): Server;
};

type StaticBuildModule = {
    buildStaticWeb(options: { root: string; outDir: string; deploymentMode?: 'static' | 'server' }): { outDir: string };
};

async function listen(server: Server): Promise<string> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
}

async function fetchOk(baseUrl: string, path: string): Promise<Response> {
    const response = await fetch(new URL(path, baseUrl));
    assert.equal(response.status, 200, `${path} should be served`);
    return response;
}

async function fetchText(baseUrl: string, path: string): Promise<string> {
    return (await fetchOk(baseUrl, path)).text();
}

async function fetchBytes(baseUrl: string, path: string): Promise<ArrayBuffer> {
    return (await fetchOk(baseUrl, path)).arrayBuffer();
}

async function closeServer(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
}

function readDataAttribute(html: string, name: string): string {
    const match = html.match(new RegExp(`\\bdata-${name}="([^"]+)"`));
    assert.ok(match, `Missing data-${name}`);
    return match[1];
}

function readPatchedTikzRuntimeAssets(source: string): string[] {
    const match = source.match(/await Promise\.all\((\[[^\]]+\])\.map\(\(async A=>\{snaptexAssets\[A\]=await c\(A\)/);
    assert.ok(match, 'Missing patched TikZJax runtime asset manifest');
    return JSON.parse(match[1]) as string[];
}

function repoRoot(): string {
    return resolve(__dirname, '..', '..', '..');
}

suite('Standalone web assets', () => {
    test('builds and serves the static PWA assets used by the browser host', async function() {
        this.timeout(10000);
        const root = repoRoot();
        const outDir = join(root, 'out', 'web-assets-test');
        const outsideAsset = resolve(outDir, '..', `${basename(outDir)}-outside.txt`);
        writeFileSync(outsideAsset, 'outside');
        const buildModule = await import(pathToFileURL(resolve(root, 'apps/web/build-static.mjs')).href) as StaticBuildModule;
        const serverModule = await import(pathToFileURL(resolve(root, 'apps/web/server.mjs')).href) as WebServerModule;
        const build = buildModule.buildStaticWeb({ root, outDir });
        const server = serverModule.createSnapTeXWebServer({ root: build.outDir });
        const baseUrl = await listen(server);

        try {
            const indexHtml = await fetchText(baseUrl, '/');
            const tikzJaxUri = readDataAttribute(indexHtml, 'tikz-jax-js-uri');
            const tikzCssUri = readDataAttribute(indexHtml, 'tikz-jax-css-uri');
            const tikzBaseUri = tikzJaxUri.replace(/\/tikzjax\.js$/, '');
            assert.equal(readDataAttribute(indexHtml, 'deployment-mode'), 'static');

            for (const asset of [
                'index.html', 'manifest.webmanifest',
                'demo/main.tex', 'demo/sections/project-editing.tex', 'demo/sample.bib', 'demo/frog.jpg',
                'media/favicon.ico', 'media/icon-32.png', 'media/icon.png', 'media/icon-192.png', 'media/icon-512.png',
                'media/vendor/tikzjax/tex.wasm.gz'
            ]) {
                assert.ok(existsSync(join(build.outDir, asset)), `Missing static asset: ${asset}`);
            }
            assert.match(indexHtml, /href="manifest\.webmanifest\?v=[a-f0-9]{12}"/);
            assert.match(indexHtml, /href="media\/favicon\.ico\?v=[a-f0-9]{12}"/);
            assert.match(indexHtml, /href="media\/icon-32\.png\?v=[a-f0-9]{12}"/);
            assert.match(indexHtml, /href="media\/icon-192\.png\?v=[a-f0-9]{12}"/);
            assert.match(indexHtml, /src="media\/icon\.png\?v=[a-f0-9]{12}"/);
            assert.match(indexHtml, /src="web-main\.js\?v=[a-f0-9]{12}"/);
            assert.match(indexHtml, /connect-src 'self' blob:/);
            assert.doesNotMatch(indexHtml, /\b(?:href|src|data-[\w-]+)="\//);
            const rejectedAsset = await fetch(new URL(`/%2e%2e/${basename(outsideAsset)}`, baseUrl));
            assert.equal(rejectedAsset.status, 404);
            await rejectedAsset.arrayBuffer();

            assert.match(await fetchText(baseUrl, '/demo/main.tex'), /\\input\{sections\/project-editing\}/);
            await fetchText(baseUrl, '/demo/sections/project-editing.tex');
            await fetchText(baseUrl, '/demo/sample.bib');
            await fetchBytes(baseUrl, '/demo/frog.jpg');
            const manifest = JSON.parse(await fetchText(baseUrl, '/manifest.webmanifest'));
            assert.deepEqual(
                manifest.icons.map((icon: { sizes: string; purpose: string }) => [icon.sizes, icon.purpose]),
                [
                    ['192x192', 'any'],
                    ['512x512', 'any']
                ]
            );
            assert.match(manifest.icons[0].src, /^media\/icon-192\.png\?v=[a-f0-9]{12}$/);
            assert.match(manifest.icons[1].src, /^media\/icon-512\.png\?v=[a-f0-9]{12}$/);
            const favicon = await fetchOk(baseUrl, '/media/favicon.ico');
            assert.match(favicon.headers.get('content-type') ?? '', /image\/x-icon/);
            await favicon.arrayBuffer();
            await fetchBytes(baseUrl, '/media/icon-32.png');
            await fetchBytes(baseUrl, '/media/icon-192.png');
            await fetchBytes(baseUrl, '/media/icon-512.png');
            const serviceWorker = await fetchText(baseUrl, '/service-worker.js');
            assert.match(serviceWorker, /CACHE_PREFIX = `snaptex-web:\$\{self\.registration\.scope\}:/);
            for (const group of ['core', 'katex', 'pdf', 'tikz', 'demo']) {
                assert.match(serviceWorker, new RegExp(`"name": "${group}"`));
            }
            assert.doesNotMatch(serviceWorker, /\.nojekyll/);
            assert.doesNotMatch(serviceWorker, /asset-manifest\.json|\.js\.br|\.js\.gz/);
            for (const source of [
                /\.\/index\.html\?v=[a-f0-9]{12}/, /\.\/media\/favicon\.ico\?v=[a-f0-9]{12}/,
                /\.\/media\/icon-512\.png\?v=[a-f0-9]{12}/, /\.\/demo\/main\.tex\?v=[a-f0-9]{12}/,
                /\.\/media\/vendor\/tikzjax\/tex\.wasm\.gz\?v=[a-f0-9]{12}/
            ]) {
                assert.match(serviceWorker, source);
            }
            const mainScriptMatch = indexHtml.match(/src="(web-main\.js\?v=[a-f0-9]{12})"/);
            assert.ok(mainScriptMatch);
            const mainScript = mainScriptMatch[1];
            const firstMainResponse = await fetchOk(baseUrl, mainScript);
            assert.equal(firstMainResponse.headers.get('cache-control'), 'public, max-age=31536000, immutable');
            await firstMainResponse.arrayBuffer();
            const conditionalResponse = await fetch(new URL(mainScript, baseUrl), {
                headers: { 'If-None-Match': firstMainResponse.headers.get('etag') ?? '' }
            });
            assert.equal(conditionalResponse.status, 304);
            await conditionalResponse.arrayBuffer();
            type ServiceWorkerTestEvent = {
                request?: { method: string; mode: string; url: string };
                respondWith?(response: Promise<unknown>): void;
                waitUntil?(work: Promise<unknown>): void;
            };
            const handlers = new Map<string, (event: ServiceWorkerTestEvent) => void>();
            const deletedCaches: string[] = [];
            const populatedCaches: string[] = [];
            let networkRequests = 0;
            runInNewContext(serviceWorker, {
                Response,
                URL,
                fetch: () => {
                    networkRequests++;
                    return Promise.resolve('network-response');
                },
                caches: {
                    delete: async (name: string) => { deletedCaches.push(name); return true; },
                    keys: async () => [
                        'snaptex-web:https://snaptex.test/app/:old',
                        'snaptex-web:https://snaptex.test/other/:current',
                        'unrelated-app-cache'
                    ],
                    open: async (name: string) => ({
                        addAll: async () => { populatedCaches.push(name); },
                        match: async (request: unknown) => String(request).includes('__snaptex_complete__')
                            ? (name.includes(':core:') ? 'complete' : undefined)
                            : 'cached-response',
                        put: async () => undefined
                    })
                },
                self: {
                    addEventListener: (name: string, handler: (event: ServiceWorkerTestEvent) => void) => handlers.set(name, handler),
                    clients: { claim: async () => undefined },
                    location: { origin: 'https://snaptex.test' },
                    registration: { scope: 'https://snaptex.test/app/' },
                    skipWaiting: async () => undefined
                }
            });
            let installation = Promise.resolve<unknown>(undefined);
            handlers.get('install')?.({ waitUntil: work => { installation = work; } });
            await installation;
            assert.equal(populatedCaches.length, 4);
            assert.deepEqual(
                populatedCaches.map(name => name.match(/:(katex|pdf|tikz|demo):/)?.[1]),
                ['katex', 'pdf', 'tikz', 'demo']
            );
            let activation = Promise.resolve<unknown>(undefined);
            handlers.get('activate')?.({ waitUntil: work => { activation = work; } });
            await activation;
            assert.deepEqual(deletedCaches, ['snaptex-web:https://snaptex.test/app/:old']);

            let cachedResponse: Promise<unknown> | undefined;
            handlers.get('fetch')?.({
                request: { method: 'GET', mode: 'same-origin', url: 'https://snaptex.test/web-main.js' },
                respondWith: response => { cachedResponse = response; }
            });
            assert.equal(await cachedResponse, 'cached-response');
            handlers.get('fetch')?.({
                request: { method: 'GET', mode: 'navigate', url: 'https://snaptex.test/app/' },
                respondWith: response => { cachedResponse = response; }
            });
            assert.equal(await cachedResponse, 'cached-response');
            assert.equal(networkRequests, 0);
            handlers.get('fetch')?.({
                request: { method: 'GET', mode: 'navigate', url: 'https://snaptex.test/docs/' },
                respondWith: response => { cachedResponse = response; }
            });
            assert.equal(await cachedResponse, 'network-response');
            assert.equal(networkRequests, 1);
            await fetchText(baseUrl, tikzJaxUri);
            await fetchText(baseUrl, tikzCssUri);
            await fetchText(baseUrl, `${tikzBaseUri}/run-tex.js`);
            await fetchBytes(baseUrl, `${tikzBaseUri}/tex.wasm.gz`);
            await fetchBytes(baseUrl, `${tikzBaseUri}/core.dump.gz`);
            await fetchBytes(baseUrl, `${tikzBaseUri}/tex_files/tikzlibrarycalc.code.tex.gz`);
        } finally {
            await closeServer(server);
            rmSync(outsideAsset, { force: true });
        }
    });

    test('keeps patched TikZJax asset manifest in sync with copied files', () => {
        const tikzRoot = join(repoRoot(), 'media/vendor/tikzjax');
        const tikzJaxSource = readFileSync(join(tikzRoot, 'tikzjax.js'), 'utf8');
        const runTexSource = readFileSync(join(tikzRoot, 'run-tex.js'), 'utf8');
        const runtimeAssets = readPatchedTikzRuntimeAssets(tikzJaxSource);

        assert.match(tikzJaxSource, /URL\.createObjectURL\(new Blob\(\[await u\.text\(\)\]/);
        assert.match(tikzJaxSource, /new URL\(e\)\.origin===location\.origin/);
        assert.match(tikzJaxSource, /r\.load\(\{base:e,assets:snaptexAssets\}\)/);
        assert.match(runTexSource, /snaptexAssetUrls&&snaptexAssetUrls\[A\]\|\|`\$\{zn\}\/\$\{A\}`/);
        assert.match(runTexSource, /this\.values\[2\]=-n\*r\+g\*e,this\.values\[3\]=-B\*r\+s\*e/);
        assert.ok(runtimeAssets.includes('tex_files/tikzlibrarycalc.code.tex.gz'));
        assert.ok(runtimeAssets.includes('tex_files/pgflibraryarrows.meta.code.tex.gz'));

        for (const asset of runtimeAssets) {
            assert.ok(existsSync(join(tikzRoot, asset)), `Missing TikZJax runtime asset: ${asset}`);
        }
    });

    test('resolves relative preview assets from the deployed page directory', () => {
        assert.equal(
            resolvePreviewAssetUri('media/vendor/pdfjs/pdf.mjs', 'https://example.com/SnapTeX/'),
            'https://example.com/SnapTeX/media/vendor/pdfjs/pdf.mjs'
        );
        const webviewUri = 'https://file+.vscode-resource.vscode-cdn.net/media/vendor/pdfjs/pdf.mjs';
        assert.equal(resolvePreviewAssetUri(webviewUri, 'vscode-webview://preview/'), webviewUri);
    });
});
