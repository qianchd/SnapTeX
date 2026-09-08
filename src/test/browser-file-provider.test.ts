/// <reference types="mocha" />

import * as assert from 'assert';
import { chooseRootPath, createProjectTree, isProjectFile, isProjectTextFile, projectFolderPaths } from '../../apps/standalone/src/browser-project';
import { BrowserFileProvider, BrowserUri } from '../../apps/standalone/src/browser-file-provider';
import { BrowserWorkspaceStore } from '../../apps/web/src/indexeddb-project';
import { createProjectZip } from '../../apps/standalone/src/project-archive';
import { createDirectoryProject, type BrowserDirectoryHandle, type BrowserFileHandle } from '../../apps/web/src/local-project';
import { PreviewUpdateService } from '../preview-update-service';

suite('BrowserFileProvider', () => {
    async function withFakeIndexedDb<T>(callback: () => Promise<T>): Promise<T> {
        const fake = await import('fake-indexeddb');
        const names = [
            'indexedDB',
            'IDBCursor',
            'IDBCursorWithValue',
            'IDBDatabase',
            'IDBFactory',
            'IDBIndex',
            'IDBKeyRange',
            'IDBObjectStore',
            'IDBOpenDBRequest',
            'IDBRequest',
            'IDBTransaction',
            'IDBVersionChangeEvent'
        ] as const;
        const globalValues = globalThis as unknown as Record<string, unknown>;
        const previous = new Map(names.map(name => [name, globalValues[name]]));
        for (const name of names) {
            globalValues[name] = fake[name];
        }
        try {
            return await callback();
        } finally {
            for (const name of names) {
                if (previous.get(name) === undefined) {
                    delete globalValues[name];
                } else {
                    globalValues[name] = previous.get(name);
                }
            }
        }
    }

    test('selects browser project roots and text files with shared project helpers', () => {
        const files = [
            { path: '/project/sections/intro.tex', text: 'Intro' },
            { path: '/project/root.tex', text: 'Root' },
            { path: '/project/main.tex', text: 'Main' },
            { path: '/project/figure.png', blob: new Blob(['image']) }
        ];

        assert.equal(chooseRootPath(files), '/project/main.tex');
        assert.deepEqual(projectFolderPaths(files.map(file => file.path)), ['/project', '/project/sections']);
        assert.deepEqual(createProjectTree(files.map(file => file.path)).children.map(node => [node.kind, node.path]), [
            ['folder', '/project']
        ]);
        assert.equal(isProjectFile('/project/figure.png'), true);
        assert.equal(isProjectTextFile('/project/notes.md'), true);
        assert.equal(isProjectFile('/project/build.aux'), false);
    });

    test('lets the preview pipeline read included project files', async () => {
        const provider = new BrowserFileProvider();
        const rootUri = new BrowserUri('/project/main.tex');
        provider.setProjectFiles([
            {
                path: rootUri.path,
                text: [
                    '\\begin{document}',
                    'Root paragraph.',
                    '\\input{sections/intro}',
                    '\\end{document}'
                ].join('\n')
            },
            {
                path: '/project/sections/intro.tex',
                readText: async () => 'Included paragraph.'
            }
        ]);
        const service = new PreviewUpdateService(provider);

        const payload = await service.render(rootUri, await provider.read(rootUri), { deferFullHtml: false });

        assert.match(payload.htmls?.join('\n') ?? '', /Included paragraph/);
    });

    test('creates and deletes files through a writable browser directory', async () => {
        const written = new Map<string, string>();
        const removed: string[] = [];
        const fileHandle = (name: string): BrowserFileHandle => ({
            kind: 'file',
            name,
            getFile: async () => new File([written.get(name) ?? ''], name),
            createWritable: async () => ({
                write: text => { written.set(name, text); },
                close: () => undefined
            })
        });
        const sections: BrowserDirectoryHandle = {
            kind: 'directory',
            name: 'sections',
            values: async function* () { return; },
            getFileHandle: async name => fileHandle(name),
            getDirectoryHandle: async () => { throw new Error('Unexpected nested directory.'); },
            removeEntry: async name => { removed.push(`sections/${name}`); }
        };
        const root: BrowserDirectoryHandle = {
            kind: 'directory',
            name: 'project',
            values: async function* () { yield fileHandle('main.tex'); },
            getFileHandle: async name => fileHandle(name),
            getDirectoryHandle: async name => {
                assert.equal(name, 'sections');
                return sections;
            },
            removeEntry: async name => { removed.push(name); }
        };

        const project = await createDirectoryProject(root);
        assert.ok(project.operations);
        const created = await project.operations.createTextFile('/sections/notes.md', 'Draft');
        await project.operations.deleteFile('/sections/notes.md');

        assert.equal(created.path, '/sections/notes.md');
        assert.equal(written.get('notes.md'), 'Draft');
        assert.deepEqual(removed, ['sections/notes.md']);
    });

    test('shares concurrent lazy resource reads and reuses their object URL', async () => {
        const provider = new BrowserFileProvider();
        let reads = 0;
        let urls = 0;
        provider.setProjectFiles([{
            path: '/figure.png',
            readBlob: async () => {
                reads++;
                await new Promise(resolve => setTimeout(resolve, 5));
                return new Blob(['image']);
            }
        }]);
        const uri = new BrowserUri('/figure.png');
        const result = await Promise.all([
            provider.getResourceUrl(uri, () => `blob:${++urls}`),
            provider.getResourceUrl(uri, () => `blob:${++urls}`)
        ]);
        const reused = await provider.getResourceUrl(uri, () => `blob:${++urls}`);
        assert.deepEqual(result, ['blob:1', 'blob:1']);
        assert.equal(reused, 'blob:1');
        assert.equal(reads, 1);
        assert.equal(urls, 1);
    });

    test('does not retain lazily loaded binary files after project snapshots', async () => {
        const provider = new BrowserFileProvider();
        let reads = 0;
        provider.setProjectFiles([{
            path: '/figure.png',
            readBlob: async () => {
                reads++;
                return new Blob(['image']);
            }
        }]);

        await provider.snapshot();
        await provider.snapshot();

        assert.equal(reads, 2);
    });

    test('keeps same-named browser projects independent and restores edited text', async () => {
        await withFakeIndexedDb(async () => {
            const databaseName = `snaptex-test-${Date.now()}-${Math.random()}`;
            const firstStore = new BrowserWorkspaceStore(databaseName);
            try {
            const first = await firstStore.importFiles('paper', [
                { path: '/paper/main.tex', file: new Blob(['First']) },
                { path: '/paper/figure.png', file: new Blob(['image']) }
            ]);
            const second = await firstStore.importFiles('paper', [
                { path: '/paper/main.tex', file: new Blob(['Second']) }
            ]);
            assert.notEqual(first.id, second.id);

            const firstProject = await firstStore.open(first.id);
            const firstMain = firstProject.files.find(file => file.path === '/main.tex');
            assert.ok(firstMain?.readText && firstMain.writeText);
            assert.equal(await firstMain.readText(), 'First');
            await firstMain.writeText('Edited first');
            const reopenedFirst = await firstStore.open(first.id);
            assert.equal(await reopenedFirst.files.find(file => file.path === '/main.tex')?.readText?.(), 'Edited first');

            const secondProject = await firstStore.open(second.id);
            assert.equal(await secondProject.files[0].readText?.(), 'Second');

            const resource = firstProject.files.find(file => file.path === '/figure.png');
            assert.ok(resource?.readBlob);
            assert.equal(resource?.blob, undefined);
            assert.equal(await (await resource.readBlob()).text(), 'image');

            const remoteId = await firstStore.rememberRemote('server-paper');
            const remoteProject = {
                rootPath: '/main.tex',
                files: [
                    { path: '/main.tex', text: 'Main' },
                    { path: '/appendix.tex', text: 'Appendix' }
                ]
            };
            const rememberedRemote = await firstStore.restoreProjectState(remoteId, remoteProject);
            await rememberedRemote.setRootPath?.('/appendix.tex');
            await rememberedRemote.setActivePath?.('/main.tex');
            await firstStore.rememberRemote('server-paper');
            const restoredRemote = await firstStore.restoreProjectState(remoteId, remoteProject);
            assert.equal(restoredRemote.rootPath, '/appendix.tex');
            assert.equal(restoredRemote.activePath, '/main.tex');
            const history = await firstStore.listHistory();
            assert.deepEqual(history.map(entry => entry.kind).sort(), ['remote', 'workspace', 'workspace']);
            assert.equal(await firstStore.remoteProjectName(remoteId), 'server-paper');
            await firstStore.forgetHistory(remoteId);
            } finally {
                await firstStore.deleteDatabase();
            }
        });
    });

    test('imports a single file without stripping its filename', async () => {
        await withFakeIndexedDb(async () => {
            const databaseName = `snaptex-test-${Date.now()}-${Math.random()}`;
            const store = new BrowserWorkspaceStore(databaseName);
            try {
                const project = await store.importFiles('single', [
                    { path: '/main.tex', file: new Blob(['Single file']) }
                ]);
                assert.equal((await store.open(project.id)).rootPath, '/main.tex');
            } finally {
                await store.deleteDatabase();
            }
        });
    });

    test('migrates existing workspace navigation into shared project state', async () => {
        await withFakeIndexedDb(async () => {
            const databaseName = `snaptex-test-${Date.now()}-${Math.random()}`;
            const { openDB } = await import('idb');
            const legacy = await openDB(databaseName, 2, {
                upgrade(db) {
                    db.createObjectStore('projects', { keyPath: 'id' });
                    const files = db.createObjectStore('files', { keyPath: 'key' });
                    files.createIndex('by-project', 'projectId');
                    db.createObjectStore('contents', { keyPath: 'key' });
                    db.createObjectStore('history', { keyPath: 'id' });
                }
            });
            await legacy.put('projects', {
                id: 'legacy', name: 'Legacy', rootPath: '/paper.tex', activePath: '/appendix.tex', lastOpenedAt: 1
            });
            await legacy.put('files', {
                key: 'legacy\0/paper.tex', projectId: 'legacy', path: '/paper.tex', baseHash: '', currentHash: ''
            });
            await legacy.put('files', {
                key: 'legacy\0/appendix.tex', projectId: 'legacy', path: '/appendix.tex', baseHash: '', currentHash: ''
            });
            await legacy.put('contents', { key: 'legacy\0/paper.tex', content: new Blob(['Paper']) });
            await legacy.put('contents', { key: 'legacy\0/appendix.tex', content: new Blob(['Appendix']) });
            legacy.close();

            const store = new BrowserWorkspaceStore(databaseName);
            try {
                assert.equal((await store.listHistory())[0].detail, '/paper.tex');
                const project = await store.open('legacy');
                assert.equal(project.rootPath, '/paper.tex');
                assert.equal(project.activePath, '/appendix.tex');
            } finally {
                await store.deleteDatabase();
            }
        });
    });

    test('preserves project state while detecting conflicting re-imports', async () => {
        await withFakeIndexedDb(async () => {
            const databaseName = `snaptex-test-${Date.now()}-${Math.random()}`;
            const store = new BrowserWorkspaceStore(databaseName);
            try {
                const project = await store.importFiles('paper', [
                    { path: '/main.tex', file: new Blob(['Base']) },
                    { path: '/alt.tex', file: new Blob(['Alternative']) },
                    { path: '/figure.png', file: new Blob(['Old image']) }
                ]);
                const opened = await store.open(project.id);
                const main = opened.files.find(file => file.path === '/main.tex');
                assert.ok(main);
                await main.writeText?.('Local');
                await opened.setRootPath?.('/alt.tex');
                await assert.rejects(() => opened.setRootPath?.('/missing.tex') ?? Promise.resolve(), /does not exist/);
                await assert.rejects(() => opened.operations?.deleteFile('/alt.tex') ?? Promise.resolve(), /preview root/);
                await assert.rejects(() => opened.operations?.createTextFile('/image.png', '') ?? Promise.resolve(), /text files/);

                const unchangedSource = await store.reimportFiles(project.id, [
                    { path: '/main.tex', file: new Blob(['Base']) },
                    { path: '/alt.tex', file: new Blob(['Alternative']) },
                    { path: '/figure.png', file: new Blob(['New image']) }
                ]);
                assert.equal(unchangedSource.length, 0);
                assert.equal(await (await store.open(project.id)).files.find(file => file.path === '/main.tex')?.readText?.(), 'Local');
                assert.equal(await (await (await store.open(project.id)).files.find(file => file.path === '/figure.png')?.readBlob?.())?.text(), 'New image');

                const conflict = await store.reimportFiles(project.id, [
                    { path: '/main.tex', file: new Blob(['Remote']) },
                    { path: '/alt.tex', file: new Blob(['Alternative']) },
                    { path: '/figure.png', file: new Blob(['New image']) }
                ]);
                assert.equal(conflict.length, 1);

                const merged = await store.reimportFiles(project.id, [
                    { path: '/main.tex', file: new Blob(['Local']) },
                    { path: '/alt.tex', file: new Blob(['Alternative']) },
                    { path: '/figure.png', file: new Blob(['New image']) }
                ]);
                assert.equal(merged.length, 0);
                const reopened = await store.open(project.id);
                assert.equal(reopened.rootPath, '/alt.tex');
                assert.equal(reopened.activePath, '/main.tex');
                assert.equal(await reopened.files.find(file => file.path === '/main.tex')?.readText?.(), 'Local');

                await opened.operations?.createTextFile('/notes.tex', 'New local file');
                const missingLocalFile = await store.reimportFiles(project.id, [
                    { path: '/main.tex', file: new Blob(['Local']) },
                    { path: '/alt.tex', file: new Blob(['Alternative']) },
                    { path: '/figure.png', file: new Blob(['New image']) }
                ]);
                assert.deepEqual(missingLocalFile, ['/notes.tex']);
            } finally {
                await store.deleteDatabase();
            }
        });
    });

    test('exports text and binary project files as a ZIP snapshot', async () => {
        const blob = await createProjectZip({
            name: 'sample',
            files: [
                { path: '/main.tex', content: new Blob(['Document']) },
                { path: '/figure.png', content: new Blob(['image']) }
            ]
        });
        const { default: Zip } = await import('jszip');
        const zip = await Zip.loadAsync(await blob.arrayBuffer());
        assert.equal(await zip.file('main.tex')?.async('text'), 'Document');
        assert.equal(await zip.file('figure.png')?.async('text'), 'image');
    });
});
