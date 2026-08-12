/// <reference types="mocha" />

import * as assert from 'assert';
import { loadRemoteProject } from '../../apps/web/src/remote-project';

suite('RemoteProject', () => {
    test('loads, saves, and exposes resources through the project HTTP API', async () => {
        const requests: Array<{ url: string; method: string; body?: string }> = [];
        let mainText = '\\documentclass{article}';
        const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = String(input);
            const method = init?.method ?? 'GET';
            requests.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
            if (url.endsWith('/manifest')) {
                return Response.json({
                    rootPath: '/project/main.tex',
                    files: [
                        '/project/main.tex',
                        '/project/sections/my intro.tex',
                        '/project/figure.png'
                    ]
                });
            }
            if (url.endsWith('/files/project/main.tex')) {
                if (method === 'PUT') {
                    mainText = String(init?.body ?? '');
                    return new Response(null, { status: 204 });
                }
                return new Response(mainText);
            }
            if (url.endsWith('/files/project/sections/my%20intro.tex')) {
                return new Response('Included text.');
            }
            return new Response(null, { status: 404 });
        };

        const project = await loadRemoteProject('https://example.test/api/project/', fetcher);
        const mainFile = project.files.find(file => file.path === '/project/main.tex');
        const includedFile = project.files.find(file => file.path.endsWith('/my intro.tex'));
        const imageFile = project.files.find(file => file.path.endsWith('/figure.png'));

        assert.equal(project.rootPath, '/project/main.tex');
        assert.equal(await mainFile?.readText?.(), '\\documentclass{article}');
        assert.equal(await includedFile?.readText?.(), 'Included text.');
        await mainFile?.writeText?.('Updated document.');
        assert.equal(mainText, 'Updated document.');
        assert.equal(imageFile?.resourceUrl, 'https://example.test/api/project/files/project/figure.png');
        assert.ok(requests.some(request => request.method === 'PUT' && request.body === 'Updated document.'));
    });
});
