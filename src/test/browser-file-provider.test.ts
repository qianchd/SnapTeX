/// <reference types="mocha" />

import * as assert from 'assert';
import { chooseRootPath, createProjectTree, isProjectFile, isProjectTextFile, projectFolderPaths } from '../../apps/standalone/src/browser-project';
import { BrowserFileProvider, BrowserUri } from '../../apps/standalone/src/browser-file-provider';
import { createDemoProjectFiles } from '../../apps/web/src/demo-project';
import { createDirectoryProject, type BrowserDirectoryHandle, type BrowserFileHandle } from '../../apps/web/src/local-project';
import { PreviewUpdateService } from '../preview-update-service';

suite('BrowserFileProvider', () => {
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

    test('persists edited demo text in browser storage', async () => {
        const values = new Map<string, string>();
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value)
        };
        const fetchDemoText = async (url: string) => `Bundled ${url}`;
        const mainFile = createDemoProjectFiles(fetchDemoText, storage)
            .find(file => file.path === '/demo/main.tex');
        assert.ok(mainFile?.readText && mainFile.writeText);

        assert.equal(await mainFile.readText(), 'Bundled demo/main.tex');
        await mainFile.writeText('Edited demo');

        const reopenedMainFile = createDemoProjectFiles(fetchDemoText, storage)
            .find(file => file.path === '/demo/main.tex');
        assert.equal(await reopenedMainFile?.readText?.(), 'Edited demo');
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
});
