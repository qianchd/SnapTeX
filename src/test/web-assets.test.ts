/// <reference types="mocha" />

import * as assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import type { Server } from 'http';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

type WebServerModule = {
    createSnapTeXWebServer(options: { root: string; port: number }): Server;
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
    test('serves TikZJax runtime assets used by the browser host', async function() {
        this.timeout(10000);
        const root = repoRoot();
        const serverModule = await import(pathToFileURL(resolve(root, 'apps/web/server.mjs')).href) as WebServerModule;
        const server = serverModule.createSnapTeXWebServer({ root, port: 0 });
        const baseUrl = await listen(server);

        try {
            const indexHtml = await fetchText(baseUrl, '/apps/web/index.html');
            const tikzJaxUri = readDataAttribute(indexHtml, 'tikz-jax-js-uri');
            const tikzCssUri = readDataAttribute(indexHtml, 'tikz-jax-css-uri');
            const tikzBaseUri = tikzJaxUri.replace(/\/tikzjax\.js$/, '');

            await fetchText(baseUrl, tikzJaxUri);
            await fetchText(baseUrl, tikzCssUri);
            await fetchText(baseUrl, `${tikzBaseUri}/run-tex.js`);
            await fetchBytes(baseUrl, `${tikzBaseUri}/tex.wasm.gz`);
            await fetchBytes(baseUrl, `${tikzBaseUri}/core.dump.gz`);
            await fetchBytes(baseUrl, `${tikzBaseUri}/tex_files/tikzlibrarycalc.code.tex.gz`);
        } finally {
            await closeServer(server);
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
