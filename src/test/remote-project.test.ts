/// <reference types="mocha" />

import * as assert from 'assert';
import {
    createRemoteProject,
    loadRemoteProject,
    RemoteProjectAuthenticationError,
    RemoteProjectNotFoundError
} from '../../apps/web/src/remote-project';
import { ProjectWriteConflictError } from '../../apps/standalone/src/browser-project';

suite('RemoteProject', () => {
    test('loads, saves, and exposes resources through the project HTTP API', async () => {
        const requests: Array<{ url: string; method: string; body?: string; headers: Headers }> = [];
        let mainText = '\\documentclass{article}';
        let mainRevision = 1;
        const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = String(input);
            const method = init?.method ?? 'GET';
            const headers = new Headers(init?.headers);
            requests.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined, headers });
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
                    ],
                    revisions: {
                        '/project/main.tex': String(mainRevision),
                        '/project/sections/my intro.tex': '1'
                    }
                });
            }
            if (url.endsWith('/files/project/main.tex')) {
                if (method === 'PUT') {
                    if (headers.get('if-match') !== `"${mainRevision}"`) {
                        return new Response(mainText, { status: 412, headers: { ETag: `"${mainRevision}"` } });
                    }
                    mainText = String(init?.body ?? '');
                    mainRevision += 1;
                    return new Response(null, { status: 204, headers: { ETag: `"${mainRevision}"` } });
                }
                if (headers.get('if-none-match') === `"${mainRevision}"`) {
                    return new Response(null, { status: 304, headers: { ETag: `"${mainRevision}"` } });
                }
                return new Response(mainText, { headers: { ETag: `"${mainRevision}"` } });
            }
            if (url.endsWith('/files/project/sections/my%20intro.tex')) {
                return new Response('Included text.', { headers: { ETag: '"intro-1"' } });
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
        assert.ok(requests.some(request => request.method === 'PUT' && request.headers.has('if-match')));
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
                return Response.json({ rootPath: '/main.tex', files: ['/main.tex'], revisions: { '/main.tex': '1' } }, { status: 201 });
            }
            if (created) {
                return Response.json({ rootPath: '/main.tex', files: ['/main.tex'], revisions: { '/main.tex': '1' } });
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

    test('reports authentication required for protected project requests', async () => {
        const fetcher = async (): Promise<Response> => Response.json({ error: 'unauthorized' }, { status: 401 });
        await assert.rejects(
            () => loadRemoteProject('paper', 'https://example.test/api/projects/', fetcher),
            RemoteProjectAuthenticationError
        );
    });

    test('watches changed files and rejects stale writes', async () => {
        let text = 'Base';
        let revision = 1;
        let intervalCallback: (() => void) | undefined;
        const originalSetInterval = globalThis.setInterval;
        const originalClearInterval = globalThis.clearInterval;
        globalThis.setInterval = ((callback: () => void) => {
            intervalCallback = callback;
            return 1 as unknown as ReturnType<typeof setInterval>;
        }) as typeof setInterval;
        globalThis.clearInterval = (() => undefined) as typeof clearInterval;
        const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = String(input);
            const headers = new Headers(init?.headers);
            if (url.endsWith('/web-auth/session')) {
                return Response.json({ csrfToken: 'test-csrf-token' });
            }
            if (url.endsWith('/manifest')) {
                return Response.json({ rootPath: '/main.tex', files: ['/main.tex'], revisions: { '/main.tex': String(revision) } });
            }
            if (init?.method === 'PUT') {
                return new Response(text, { status: 412, headers: { ETag: `"${revision}"` } });
            }
            if (headers.get('if-none-match') === `"${revision}"`) {
                return new Response(null, { status: 304, headers: { ETag: `"${revision}"` } });
            }
            return new Response(text, { headers: { ETag: `"${revision}"` } });
        };

        try {
            const project = await loadRemoteProject('paper', 'https://example.test/api/projects/', fetcher);
            const file = project.files[0];
            assert.equal(await file.readText?.(), 'Base');
            const changes: string[] = [];
            const stop = project.watchTextFiles?.(change => { changes.push(change.text); }, error => assert.fail(String(error)));
            text = 'Changed externally';
            revision += 1;
            intervalCallback?.();
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.deepEqual(changes, ['Changed externally']);
            await assert.rejects(async () => { await file.writeText?.('Local edit'); }, ProjectWriteConflictError);
            stop?.();
        } finally {
            globalThis.setInterval = originalSetInterval;
            globalThis.clearInterval = originalClearInterval;
        }
    });
});
