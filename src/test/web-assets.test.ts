/// <reference types="mocha" />

import * as assert from 'assert';
import { createHash } from 'crypto';
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
    test('builds and serves the static PWA assets used by the browser host', async () => {
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
                'media/icon.svg',
                'media/vendor/tikzjax/tex.wasm.gz'
            ]) {
                assert.ok(existsSync(join(build.outDir, asset)), `Missing static asset: ${asset}`);
            }
            assert.match(indexHtml, /href="manifest\.webmanifest\?v=[a-f0-9]{12}"/);
            assert.match(indexHtml, /href="media\/icon\.svg\?v=[a-f0-9]{12}"/);
            assert.equal(indexHtml.match(/src="media\/icon\.svg\?v=[a-f0-9]{12}"/g)?.length, 2);
            assert.doesNotMatch(indexHtml, /media\/(?:icon[^"?]*\.png|favicon\.ico)/);
            for (const rasterIcon of ['media/favicon.ico', 'media/icon.png', 'media/icon-32.png', 'media/icon-192.png', 'media/icon-512.png']) {
                assert.equal(existsSync(join(build.outDir, rasterIcon)), false, `${rasterIcon} must not ship with the Web app`);
            }
            assert.match(indexHtml, /src="web-main\.js\?v=[a-f0-9]{12}"/);
            assert.match(indexHtml, /connect-src 'self' blob:/);
            assert.doesNotMatch(indexHtml, /\b(?:href|src|srcset|data-[\w-]+)="\//);
            const rejectedAsset = await fetch(new URL(`/%2e%2e/${basename(outsideAsset)}`, baseUrl));
            assert.equal(rejectedAsset.status, 404);
            await rejectedAsset.arrayBuffer();

            assert.match(await fetchText(baseUrl, '/demo/main.tex'), /\\input\{sections\/project-editing\}/);
            await fetchText(baseUrl, '/demo/sections/project-editing.tex');
            await fetchText(baseUrl, '/demo/sample.bib');
            await fetchBytes(baseUrl, '/demo/frog.jpg');
            const manifest = JSON.parse(await fetchText(baseUrl, '/manifest.webmanifest'));
            assert.equal(manifest.theme_color, '#000000');
            assert.deepEqual(
                manifest.icons.map((icon: { sizes: string; type: string; purpose: string }) => [icon.sizes, icon.type, icon.purpose]),
                [
                    ['any', 'image/svg+xml', 'any']
                ]
            );
            assert.match(manifest.icons[0].src, /^media\/icon\.svg\?v=[a-f0-9]{12}$/);
            const svgIcon = await fetchOk(baseUrl, '/media/icon.svg');
            assert.match(svgIcon.headers.get('content-type') ?? '', /image\/svg\+xml/);
            assert.match(await svgIcon.text(), /<svg\b/);
            const serviceWorker = await fetchText(baseUrl, '/service-worker.js');
            assert.doesNotMatch(serviceWorker, /media\/(?:icon[^"?]*\.png|favicon\.ico)/);
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
            const cacheEntries = new Map<string, Map<string, ArrayBuffer>>();
            const cacheKey = (request: unknown) => new URL(
                typeof request === 'string' ? request : (request as { url: string }).url,
                'https://snaptex.test/app/'
            ).pathname;
            let networkRequests = 0;
            let offline = false;
            let failKatexInstall = true;
            runInNewContext(serviceWorker, {
                Response,
                URL,
                fetch: () => {
                    networkRequests++;
                    return offline ? Promise.reject(new Error('Offline')) : Promise.resolve(new Response('network-response'));
                },
                caches: {
                    delete: async (name: string) => { deletedCaches.push(name); return true; },
                    keys: async () => [
                        'snaptex-web:https://snaptex.test/app/:old',
                        'snaptex-web:https://snaptex.test/other/:current',
                        'unrelated-app-cache'
                    ],
                    open: async (name: string) => {
                        let entries = cacheEntries.get(name);
                        if (!entries) { entries = new Map(); cacheEntries.set(name, entries); }
                        const store = entries;
                        return {
                            addAll: async (assets: string[]) => {
                                populatedCaches.push(name);
                                if (name.includes(':katex:') && failKatexInstall) {
                                    failKatexInstall = false;
                                    throw new Error('Temporary asset download failure.');
                                }
                                const content = new Map<string, ArrayBuffer>();
                                for (const asset of assets) {
                                    assert.match(asset, /\?v=[a-f0-9]{12}$/);
                                    const url = new URL(asset, 'https://snaptex.test/app/');
                                    const assetPath = url.pathname.slice('/app/'.length);
                                    const filePath = join(build.outDir, assetPath);
                                    assert.ok(existsSync(filePath), `Missing offline asset: ${asset}`);
                                    const bytes = readFileSync(filePath);
                                    assert.equal(url.searchParams.get('v'), createHash('sha256').update(bytes).digest('hex').slice(0, 12));
                                    assert.doesNotMatch(asset, /\.nojekyll|asset-manifest\.json|\.(?:js|css)\.(?:br|gz)(?:\?|$)/);
                                    content.set(cacheKey(asset), Uint8Array.from(bytes).buffer);
                                }
                                content.forEach((bytes, key) => store.set(key, bytes));
                            },
                            match: async (request: unknown) => {
                                const bytes = store.get(cacheKey(request));
                                return bytes ? new Response(bytes) : undefined;
                            },
                            put: async (request: unknown, response: Response) => {
                                store.set(cacheKey(request), await response.arrayBuffer());
                            }
                        };
                    }
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
            await assert.rejects(installation, /Temporary asset download failure/);
            assert.equal(populatedCaches.length, 2, 'Installation should stop when a group fails');
            assert.ok(cacheEntries.get(populatedCaches[0])?.has('/app/__snaptex_complete__'));
            assert.equal(cacheEntries.get(populatedCaches[1])?.has('/app/__snaptex_complete__'), false);

            handlers.get('install')?.({ waitUntil: work => { installation = work; } });
            await installation;
            assert.deepEqual(
                populatedCaches.map(name => name.match(/:(core|katex|pdf|tikz|demo):/)?.[1]),
                ['core', 'katex', 'katex', 'pdf', 'tikz', 'demo']
            );
            handlers.get('install')?.({ waitUntil: work => { installation = work; } });
            await installation;
            assert.equal(populatedCaches.length, 6, 'Completed groups must not be downloaded again');
            let activation = Promise.resolve<unknown>(undefined);
            handlers.get('activate')?.({ waitUntil: work => { activation = work; } });
            await activation;
            assert.deepEqual(deletedCaches, ['snaptex-web:https://snaptex.test/app/:old']);

            offline = true;
            let cachedResponse: Promise<Response> | undefined;
            handlers.get('fetch')?.({
                request: { method: 'GET', mode: 'same-origin', url: 'https://snaptex.test/app/web-main.js' },
                respondWith: response => { cachedResponse = response as Promise<Response>; }
            });
            assert.equal(await (await cachedResponse)?.text(), readFileSync(join(build.outDir, 'web-main.js'), 'utf8'));
            handlers.get('fetch')?.({
                request: { method: 'GET', mode: 'navigate', url: 'https://snaptex.test/app/' },
                respondWith: response => { cachedResponse = response as Promise<Response>; }
            });
            assert.equal(await (await cachedResponse)?.text(), readFileSync(join(build.outDir, 'index.html'), 'utf8'));
            for (const asset of ['media/icon.svg', tikzJaxUri, 'media/vendor/tikzjax/tex.wasm.gz', 'media/vendor/pdfjs/pdf.mjs', 'demo/main.tex']) {
                handlers.get('fetch')?.({
                    request: { method: 'GET', mode: 'same-origin', url: new URL(asset, 'https://snaptex.test/app/').href },
                    respondWith: response => { cachedResponse = response as Promise<Response>; }
                });
                const response = await cachedResponse;
                assert.ok(response, `Expected an offline response for ${asset}`);
                const assetPath = new URL(asset, 'https://snaptex.test/app/').pathname.slice('/app/'.length);
                const expected = readFileSync(join(build.outDir, assetPath));
                assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, asset);
            }
            assert.equal(networkRequests, 0);
            let intercepted = false;
            for (const url of ['https://snaptex.test/api/projects/example/manifest', 'https://snaptex.test/web-auth/session', 'https://other.test/app/']) {
                handlers.get('fetch')?.({
                    request: { method: 'GET', mode: 'same-origin', url },
                    respondWith: () => { intercepted = true; }
                });
            }
            assert.equal(intercepted, false, 'Private API and other origins must bypass the PWA cache');
            offline = false;
            handlers.get('fetch')?.({
                request: { method: 'GET', mode: 'navigate', url: 'https://snaptex.test/docs/' },
                respondWith: response => { cachedResponse = response as Promise<Response>; }
            });
            assert.equal(await (await cachedResponse)?.text(), 'network-response');
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
