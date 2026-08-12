/// <reference types="mocha" />

import * as assert from 'assert';
import { createRemoteProject, loadRemoteProject, RemoteProjectNotFoundError } from '../../apps/web/src/remote-project';

suite('RemoteProject', () => {
    test('loads, saves, and exposes resources through the project HTTP API', async () => {
        const requests: Array<{ url: string; method: string; body?: string }> = [];
        let mainText = '\\documentclass{article}';
        const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = String(input);
            const method = init?.method ?? 'GET';
            requests.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
            if (url.endsWith('/web-auth/session')) {
                return Response.json({ csrfToken: 'test-csrf-token' });
            }
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
            if (url.endsWith('/files/notes.md') && (method === 'POST' || method === 'DELETE')) {
                return new Response(null, { status: method === 'POST' ? 201 : 204 });
            }
            return new Response(null, { status: 404 });
        };

        const project = await loadRemoteProject('paper-one', 'https://example.test/api/projects/', fetcher);
        const mainFile = project.files.find(file => file.path === '/project/main.tex');
        const includedFile = project.files.find(file => file.path.endsWith('/my intro.tex'));
        const imageFile = project.files.find(file => file.path.endsWith('/figure.png'));

        assert.equal(project.rootPath, '/project/main.tex');
        assert.equal(await mainFile?.readText?.(), '\\documentclass{article}');
        assert.equal(await includedFile?.readText?.(), 'Included text.');
        await mainFile?.writeText?.('Updated document.');
        assert.equal(mainText, 'Updated document.');
        assert.equal(imageFile?.resourceUrl, 'https://example.test/api/projects/paper-one/files/project/figure.png');
        assert.ok(requests.some(request => request.method === 'PUT' && request.body === 'Updated document.'));
        assert.ok(requests.some(request => request.url === 'https://example.test/web-auth/session'));

        const created = await project.operations?.createTextFile('/notes.md', 'Draft');
        assert.equal(created?.path, '/notes.md');
        await project.operations?.deleteFile('/notes.md');
        assert.ok(requests.some(request => request.method === 'POST' && request.url.endsWith('/files/notes.md')));
        assert.ok(requests.some(request => request.method === 'DELETE' && request.url.endsWith('/files/notes.md')));
    });

    test('distinguishes missing projects and can create them', async () => {
        let created = false;
        let createRequests = 0;
        const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            if (String(input).endsWith('/web-auth/session')) {
                return Response.json({ csrfToken: 'test-csrf-token' });
            }
            const method = init?.method ?? 'GET';
            if (method === 'POST') {
                created = true;
                createRequests += 1;
                return Response.json({ rootPath: '/main.tex', files: ['/main.tex'] }, { status: 201 });
            }
            if (created) {
                return Response.json({ rootPath: '/main.tex', files: ['/main.tex'] });
            }
            return Response.json({ code: 'PROJECT_NOT_FOUND', error: 'Project does not exist.' }, { status: 404 });
        };

        await assert.rejects(
            () => loadRemoteProject('missing', 'https://example.test/api/projects/', fetcher),
            RemoteProjectNotFoundError
        );
        const project = await createRemoteProject('missing', 'https://example.test/api/projects/', fetcher);
        assert.equal(created, true);
        assert.equal(createRequests, 1);
        assert.equal(project.rootPath, '/main.tex');
    });
});
