/// <reference types="mocha" />

import * as assert from 'assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import type { Server } from 'http';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { mock } from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';
import {
    createRemoteProject,
    loadRemoteProject,
    RemoteProjectAuthenticationError,
    RemoteProjectNotFoundError
} from '../../apps/web/src/remote-project';
import { ProjectWriteConflictError } from '../../apps/standalone/src/browser-project';
import { installTestGlobals } from './test-helpers';

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
        let createRequests = 0;
        const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            if (String(input).endsWith('/web-auth/session')) {
                return Response.json({ csrfToken: 'test-csrf-token' });
            }
            const method = init?.method ?? 'GET';
            if (method === 'POST') {
                createRequests += 1;
                return Response.json({ rootPath: '/main.tex', files: ['/main.tex'], revisions: { '/main.tex': '1' } }, { status: 201 });
            }
            if (createRequests > 0) {
                return Response.json({ rootPath: '/main.tex', files: ['/main.tex'], revisions: { '/main.tex': '1' } });
            }
            return Response.json({ code: 'PROJECT_NOT_FOUND', error: 'Project does not exist.' }, { status: 404 });
        };

        await assert.rejects(
            () => loadRemoteProject('missing', 'https://example.test/api/projects/', fetcher),
            RemoteProjectNotFoundError
        );
        const project = await createRemoteProject('missing', 'https://example.test/api/projects/', fetcher);
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

    test('observes SSE changes and recovers the latest content after failures or concurrent saves', async () => {
        const document = Object.assign(new EventTarget(), { hidden: false });
        let events!: EventTarget;
        let eventSourceClosed = false;
        const restore = installTestGlobals({
            document,
            EventSource: class extends EventTarget {
                constructor() { super(); events = this; }
                close() { eventSourceClosed = true; }
            }
        });
        let text = 'Base';
        let revision = 1;
        let failure: 'manifest' | 'missing-project' | 'read' | 'apply' | 'resource' | 'resource-body' | 'missing-resource' | 'denied-resource' | undefined;
        let readGate: Promise<void> | undefined;
        let finishRead: (() => void) | undefined;
        let readSignal: AbortSignal | null | undefined;
        let notesText = 'Notes';
        let notesRevision = 1;
        let requests = 0;
        let manifestRequests = 0;
        const changes: string[] = [];
        const resources: string[] = [];
        const errors: unknown[] = [];
        let stop: (() => void) | undefined;
        const fetcher: typeof fetch = async (input, init) => {
            requests++;
            if (String(input).endsWith('/web-auth/session')) {return Response.json({ csrfToken: 'test-csrf-token' });}
            if (String(input).endsWith('/manifest')) {
                manifestRequests++;
                if (failure === 'manifest') { failure = undefined; throw new Error('Temporary disconnect'); }
                if (failure === 'missing-project') {failure = undefined; return new Response(null, { status: 404 });}
                return Response.json({ rootPath: '/main.tex', files: ['/main.tex', '/notes.tex', '/main.pdf'],
                    revisions: { '/main.tex': String(revision), '/notes.tex': String(notesRevision), '/main.pdf': String(revision) } });
            }
            if (String(input).endsWith('/notes.tex')) {
                return new Headers(init?.headers).get('If-None-Match') === `"notes-${notesRevision}"`
                    ? new Response(null, { status: 304 })
                    : new Response(notesText, { headers: { ETag: `"notes-${notesRevision}"` } });
            }
            if (String(input).endsWith('/main.pdf')) {
                if (failure === 'resource') {failure = undefined; throw new TypeError('Network disconnected');}
                if (failure === 'resource-body') {
                    failure = undefined;
                    return new Response(new ReadableStream({ start: controller => controller.error(new TypeError('Transfer interrupted')) }));
                }
                if (failure === 'missing-resource' || failure === 'denied-resource') {
                    const status = failure === 'missing-resource' ? 404 : 403;
                    failure = undefined;
                    return new Response(null, { status });
                }
                return new Response('PDF bytes');
            }
            if (init?.method === 'PUT') {
                text = String(init.body); revision++;
                return new Response(null, { status: 204, headers: { ETag: `"${revision}"` } });
            }
            if (failure === 'read') { failure = undefined; throw new Error('Temporary disconnect'); }
            const response = new Headers(init?.headers).get('If-None-Match') === `"${revision}"`
                ? new Response(null, { status: 304 })
                : new Response(text, { headers: { ETag: `"${revision}"` } });
            const gate = readGate;
            readSignal = init?.signal;
            readGate = undefined;
            await gate;
            return response;
        };
        try {
            const project = await loadRemoteProject('paper', 'https://example.test/api/projects/', fetcher);
            assert.equal(await project.files[0].readText?.(), 'Base');
            failure = 'resource';
            await assert.rejects(() => project.files.find(file => file.path === '/main.pdf')!.readBlob!(), /Network disconnected/);
            mock.timers.enable({ apis: ['setTimeout'] });
            stop = project.watchFiles!(change => {
                if (failure === 'apply') { failure = undefined; throw new Error('Temporary update failure'); }
                changes.push(change.text);
            }, error => errors.push(error), async file => {await file.readBlob?.(); resources.push(file.path);});
            const notify = (type = 'text', path = '/main.tex') =>
                events.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(path) }));
            notify();
            await settle();
            assert.deepEqual(changes, [], 'An unchanged ETag must not reapply text');
            assert.deepEqual(resources, ['/main.pdf'], 'Watching must recover an initial failed lazy read without waiting for another file change');
            for (const stage of ['manifest', 'read', 'apply'] as const) {
                failure = stage;
                text = `External ${stage}`;
                revision++;
                notify(stage === 'manifest' ? 'manifest' : 'text');
                await settle();
                assert.equal(changes.includes(text), false, 'The first attempt must fail');
                const failedText = text;
                const manifestsBeforeRetry = manifestRequests;
                text = `Newest ${stage}`;
                revision++;
                mock.timers.tick(1000);
                await settle();
                assert.equal(changes.at(-1), text, 'Retry must read the latest disk content even without another notification');
                assert.equal(changes.includes(failedText), false, 'Retry must not replay the failed snapshot');
                if (stage !== 'manifest') {
                    assert.equal(manifestRequests, manifestsBeforeRetry, 'A failed file must retry without rescanning the project manifest');
                }
            }
            assert.equal(errors.length, 3);
            for (const stage of ['resource', 'resource-body'] as const) {
                const previousResources = resources.length;
                failure = stage;
                notify('resource', '/main.pdf');
                await settle();
                assert.equal(resources.length, previousResources, 'A network failure must not acknowledge unread resource bytes');
                mock.timers.tick(1000);
                await settle();
                assert.equal(resources.length, previousResources + 1, 'A changed resource must recover through the existing watcher retry');
            }
            for (const stage of ['missing-resource', 'denied-resource', 'missing-project'] as const) {
                failure = stage;
                notify(stage === 'missing-project' ? 'manifest' : 'resource', '/main.pdf');
                await settle();
                const requestsBeforeWait = requests;
                mock.timers.tick(60_000);
                await settle();
                assert.equal(requests, requestsBeforeWait, `${stage} must not start an automatic retry loop`);
            }
            const idleRequests = requests;

            text = 'Changed in a background tab'; revision++;
            document.hidden = true;
            document.dispatchEvent(new Event('visibilitychange'));
            await settle();
            assert.equal(requests, idleRequests, 'Hiding the tab must not scan the project');
            document.hidden = false;
            document.dispatchEvent(new Event('visibilitychange'));
            await settle();
            assert.equal(changes.at(-1), text, 'Returning to the tab must catch up missed updates');

            text = 'Unreadable main'; revision++; failure = 'read';
            notesText = 'Updated notes'; notesRevision++;
            notify('manifest');
            await settle();
            assert.ok(changes.includes(notesText), 'One failed file must not block other changed files');
            mock.timers.tick(1000);
            await settle();
            assert.equal(changes.at(-1), text);

            const main = project.files[0];
            readGate = new Promise(resolve => { finishRead = resolve; });
            notify();
            await settle();
            await main.writeText?.('Saved before delayed 304', text);
            text = 'External after that save'; revision++;
            finishRead!();
            await settle();
            assert.equal(changes.at(-1), text, 'A delayed 304 for the old base must not acknowledge a newer saved version');

            const appliedChanges = changes.length;
            text = 'Snapshot before save'; revision++;
            readGate = new Promise(resolve => { finishRead = resolve; });
            notify();
            await settle();
            assert.equal(await main.readText?.(), text);
            await main.writeText?.('Saved while reading', text);
            finishRead!();
            await settle();
            assert.equal(changes.length, appliedChanges, 'An older in-flight read must not undo a successful save');
            assert.equal(await main.readText?.(), 'Saved while reading');

            text = 'Superseded snapshot'; revision++;
            readGate = new Promise(resolve => { finishRead = resolve; });
            notify();
            await settle();
            text = 'Newest during read'; revision++;
            notify();
            notify();
            finishRead!();
            await settle();
            assert.deepEqual(changes.slice(appliedChanges), [text], 'New notifications must supersede the older in-flight snapshot');

            text = 'Waiting for reconnect'; revision++; failure = 'read';
            notify();
            await settle();
            text = 'Newest after reconnect'; revision++;
            notify('manifest');
            await settle();
            assert.equal(changes.at(-1), text, 'Reconnection must resume immediately, without waiting for backoff');

            text = 'Closed'; revision++; failure = 'read';
            notify();
            await settle();
            readGate = new Promise(resolve => { finishRead = resolve; });
            notify('manifest');
            await settle();
            stop();
            assert.equal(readSignal?.aborted, true, 'Closing the watcher must cancel its in-flight request');
            assert.equal(eventSourceClosed, true);
            const stoppedRequests = requests;
            const stoppedChanges = [...changes];
            finishRead!();
            notify();
            mock.timers.tick(60_000);
            await settle();
            assert.equal(requests, stoppedRequests, 'Closing a project must cancel recovery');
            assert.deepEqual(changes, stoppedChanges, 'Closed projects must ignore in-flight and later updates');
        } finally {
            finishRead?.();
            stop?.();
            mock.timers.reset();
            restore();
        }
    });

});
