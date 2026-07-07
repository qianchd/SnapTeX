/// <reference types="mocha" />

import * as assert from 'assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import type { Server } from 'http';
import { basename, join, resolve } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

type WebServerModule = {
    createSnapTeXWebServer(options: { root: string; port: number; indexPath?: string }): Server;
};

type StaticBuildModule = {
    buildStaticWeb(options: { root: string; outDir: string }): { outDir: string; assets: string[] };
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
        const outDir = mkdtempSync(join(tmpdir(), 'snaptex-web-'));
        const outsideAsset = resolve(outDir, '..', `${basename(outDir)}-outside.txt`);
        writeFileSync(outsideAsset, 'outside');
        const buildModule = await import(pathToFileURL(resolve(root, 'apps/web/build-static.mjs')).href) as StaticBuildModule;
        const serverModule = await import(pathToFileURL(resolve(root, 'apps/web/server.mjs')).href) as WebServerModule;
        const build = buildModule.buildStaticWeb({ root, outDir });
        const server = serverModule.createSnapTeXWebServer({ root: build.outDir, port: 0 });
        const baseUrl = await listen(server);

        try {
            const indexHtml = await fetchText(baseUrl, '/');
            const tikzJaxUri = readDataAttribute(indexHtml, 'tikz-jax-js-uri');
            const tikzCssUri = readDataAttribute(indexHtml, 'tikz-jax-css-uri');
            const tikzBaseUri = tikzJaxUri.replace(/\/tikzjax\.js$/, '');

            for (const asset of [
                'index.html', 'manifest.webmanifest',
                'demo/main.tex', 'demo/sections/project-editing.tex', 'demo/sample.bib', 'demo/frog.jpg',
                'media/favicon.ico', 'media/icon-32.png', 'media/icon.png', 'media/icon-192.png', 'media/icon-512.png',
                'media/vendor/tikzjax/tex.wasm.gz'
            ]) {
                assert.ok(build.assets.includes(asset), `Missing static asset: ${asset}`);
            }
            assert.match(indexHtml, /href="manifest\.webmanifest"/);
            assert.match(indexHtml, /href="media\/favicon\.ico"/);
            assert.match(indexHtml, /href="media\/icon-32\.png"/);
            assert.match(indexHtml, /href="media\/icon-192\.png"/);
            assert.match(indexHtml, /src="media\/icon\.png"/);
            assert.doesNotMatch(indexHtml, /\b(?:href|src|data-[\w-]+)="\//);
            assert.equal((await fetch(new URL(`/%2e%2e/${basename(outsideAsset)}`, baseUrl))).status, 404);

            assert.match(await fetchText(baseUrl, '/demo/main.tex'), /\\input\{sections\/project-editing\}/);
            await fetchText(baseUrl, '/demo/sections/project-editing.tex');
            await fetchText(baseUrl, '/demo/sample.bib');
            await fetchBytes(baseUrl, '/demo/frog.jpg');
            const manifest = JSON.parse(await fetchText(baseUrl, '/manifest.webmanifest'));
            assert.deepEqual(
                manifest.icons.map((icon: { src: string; sizes: string; purpose: string }) => [icon.src, icon.sizes, icon.purpose]),
                [
                    ['media/icon-192.png', '192x192', 'any'],
                    ['media/icon-512.png', '512x512', 'any']
                ]
            );
            const favicon = await fetchOk(baseUrl, '/media/favicon.ico');
            assert.match(favicon.headers.get('content-type') ?? '', /image\/x-icon/);
            await fetchBytes(baseUrl, '/media/icon-32.png');
            await fetchBytes(baseUrl, '/media/icon-192.png');
            await fetchBytes(baseUrl, '/media/icon-512.png');
            const serviceWorker = await fetchText(baseUrl, '/service-worker.js');
            assert.match(serviceWorker, /CACHE_NAME = "snaptex-web-/);
            assert.doesNotMatch(serviceWorker, /\.nojekyll/);
            for (const source of [
                /\.\/index\.html/, /\.\/media\/favicon\.ico/, /\.\/media\/icon-512\.png/,
                /\.\/demo\/main\.tex/, /\.\/media\/vendor\/tikzjax\/tex\.wasm\.gz/
            ]) {
                assert.match(serviceWorker, source);
            }
            await fetchText(baseUrl, tikzJaxUri);
            await fetchText(baseUrl, tikzCssUri);
            await fetchText(baseUrl, `${tikzBaseUri}/run-tex.js`);
            await fetchBytes(baseUrl, `${tikzBaseUri}/tex.wasm.gz`);
            await fetchBytes(baseUrl, `${tikzBaseUri}/core.dump.gz`);
            await fetchBytes(baseUrl, `${tikzBaseUri}/tex_files/tikzlibrarycalc.code.tex.gz`);
        } finally {
            await closeServer(server);
            rmSync(outDir, { recursive: true, force: true });
            rmSync(outsideAsset, { force: true });
        }
    });

    test('keeps patched TikZJax asset manifest in sync with copied files', () => {
        const tikzRoot = join(repoRoot(), 'media/vendor/tikzjax');
        const tikzJaxSource = readFileSync(join(tikzRoot, 'tikzjax.js'), 'utf8');
        const runTexSource = readFileSync(join(tikzRoot, 'run-tex.js'), 'utf8');
        const runtimeAssets = readPatchedTikzRuntimeAssets(tikzJaxSource);

        assert.match(tikzJaxSource, /URL\.createObjectURL\(new Blob\(\[await u\.text\(\)\]/);
        assert.match(tikzJaxSource, /r\.load\(\{base:e,assets:snaptexAssets\}\)/);
        assert.match(runTexSource, /snaptexAssetUrls&&snaptexAssetUrls\[A\]\|\|`\$\{zn\}\/\$\{A\}`/);
        assert.ok(runtimeAssets.includes('tex_files/tikzlibrarycalc.code.tex.gz'));
        assert.ok(runtimeAssets.includes('tex_files/pgflibraryarrows.meta.code.tex.gz'));

        for (const asset of runtimeAssets) {
            assert.ok(existsSync(join(tikzRoot, asset)), `Missing TikZJax runtime asset: ${asset}`);
        }
    });
});
