/// <reference types="mocha" />

import * as assert from 'assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import type { Server } from 'http';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import {
    createRemoteProject,
    loadRemoteProject,
    RemoteProjectAuthenticationError,
    RemoteProjectNotFoundError
} from '../../apps/web/src/remote-project';
import { ProjectWriteConflictError } from '../../apps/standalone/src/browser-project';

suite('RemoteProject', () => {
    test('reads and writes through the real server using session, CSRF, and revision checks', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'snaptex-client-server-'));
        const staticRoot = join(directory, 'static');
        const projectsRoot = join(directory, 'projects');
        const projectRoot = join(projectsRoot, 'paper-one');
        let server: Server | undefined;
        try {
            await mkdir(staticRoot);
            await mkdir(join(projectRoot, 'sections'), { recursive: true });
            await writeFile(join(staticRoot, 'index.html'), '<body data-deployment-mode="static">Test</body>');
            await writeFile(join(projectRoot, 'main.tex'), 'Original');
            await writeFile(join(projectRoot, 'sections', 'my intro.tex'), 'Included text.');
            await writeFile(join(projectRoot, 'figure.png'), 'image');
            const serverModule = await import(pathToFileURL(resolve(__dirname, '../../../apps/web/server.mjs')).href);
            const origin = 'https://snaptex.test';
            server = serverModule.createSnapTeXWebServer({
                root: staticRoot, projectsRoot,
                auth: { username: 'test-user', password: 'a-secure-test-password', publicOrigin: origin }
            }) as Server;
            await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            const baseUrl = `http://127.0.0.1:${address.port}`;
            const login = await fetch(`${baseUrl}/web-auth/login`, {
                method: 'POST', redirect: 'manual',
                headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ username: 'test-user', password: 'a-secure-test-password' })
            });
            assert.equal(login.status, 303);
            const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
            assert.ok(cookie);
            const fetcher: typeof fetch = (input, init) => {
                const headers = new Headers(init?.headers);
                headers.set('Cookie', cookie);
                headers.set('Origin', origin);
                return fetch(input, { ...init, headers });
            };
            const project = await loadRemoteProject('paper-one', `${baseUrl}/api/projects/`, fetcher);
            const main = project.files.find(file => file.path === '/main.tex');
            assert.ok(main?.readText && main.writeText);
            assert.equal(await main.readText(), 'Original');
            assert.equal(await project.files.find(file => file.path.endsWith('/my intro.tex'))?.readText?.(), 'Included text.');
            const imageUrl = project.files.find(file => file.path === '/figure.png')?.resourceUrl;
            assert.ok(imageUrl);
            assert.equal(await (await fetcher(imageUrl)).text(), 'image');
            await main.writeText('Updated', 'Original');
            assert.equal(await readFile(join(projectRoot, 'main.tex'), 'utf8'), 'Updated');
            await writeFile(join(projectRoot, 'main.tex'), 'External edit');
            await assert.rejects(async () => main.writeText!('Stale overwrite', 'Updated'), ProjectWriteConflictError);
            assert.equal(await readFile(join(projectRoot, 'main.tex'), 'utf8'), 'External edit');
            const created = await project.operations?.createTextFile('/notes.md', 'Draft');
            assert.equal(created?.path, '/notes.md');
            assert.equal(await readFile(join(projectRoot, 'notes.md'), 'utf8'), 'Draft');
            await project.operations?.deleteFile('/notes.md');
            await assert.rejects(() => readFile(join(projectRoot, 'notes.md')));
        } finally {
            if (server) {
                server.closeAllConnections();
                await new Promise<void>(resolve => server!.close(() => resolve()));
            }
            await rm(directory, { recursive: true, force: true });
        }
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

    test('receives SSE changes, catches up on reconnect, and rejects stale saves', async () => {
        let text = 'Base';
        let revision = 1;
        let pendingManifest: Promise<Response> | undefined;
        let events: EventTarget | undefined;
        let eventSourceClosed = false;
        const OriginalEventSource = globalThis.EventSource;
        globalThis.EventSource = class extends EventTarget {
            constructor(_url: string | URL) {
                super();
                events = this;
            }
            close() { eventSourceClosed = true; }
        } as unknown as typeof EventSource;
        const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = String(input);
            const headers = new Headers(init?.headers);
            if (url.endsWith('/web-auth/session')) {
                return Response.json({ csrfToken: 'test-csrf-token' });
            }
            if (url.endsWith('/manifest')) {
                if (pendingManifest) {return pendingManifest;}
                return Response.json({ rootPath: '/main.tex', files: ['/main.tex', '/main.pdf'],
                    revisions: { '/main.tex': String(revision), '/main.pdf': String(revision) } });
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
            const resources: string[] = [];
            let changed: (() => void) | undefined;
            const stop = project.watchFiles?.(change => {
                changes.push(change.text);
                changed?.();
            }, error => assert.fail(String(error)), file => resources.push(file.path));
            for (const [type, content] of [['text', 'Changed externally'], ['manifest', 'Changed while disconnected']]) {
                text = content;
                revision += 1;
                await new Promise<void>(resolve => {
                    changed = resolve;
                    events?.dispatchEvent(new MessageEvent(type, { data: JSON.stringify('/main.tex') }));
                });
            }
            assert.deepEqual(changes, ['Changed externally', 'Changed while disconnected']);
            assert.deepEqual(resources, ['/main.pdf']);
            events?.dispatchEvent(new MessageEvent('resource', { data: JSON.stringify('/main.pdf') }));
            assert.deepEqual(resources, ['/main.pdf', '/main.pdf']);
            await assert.rejects(async () => { await file.writeText?.('Local edit'); }, ProjectWriteConflictError);
            let finishManifest!: (response: Response) => void;
            pendingManifest = new Promise(resolve => {finishManifest = resolve;});
            events?.dispatchEvent(new MessageEvent('manifest'));
            stop?.();
            finishManifest(Response.json({ rootPath: '/main.tex', files: ['/main.tex', '/main.pdf'],
                revisions: { '/main.tex': 'closed', '/main.pdf': 'closed' } }));
            assert.equal(eventSourceClosed, true);
            text = 'Change after project close';
            revision += 1;
            events?.dispatchEvent(new MessageEvent('text', { data: JSON.stringify('/main.tex') }));
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.deepEqual(changes, ['Changed externally', 'Changed while disconnected'], 'Closed projects must ignore later server events');
            assert.deepEqual(resources, ['/main.pdf', '/main.pdf'], 'An in-flight manifest must not update a closed project');
        } finally {
            globalThis.EventSource = OriginalEventSource;
        }
    });
});
