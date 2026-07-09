/// <reference types="mocha" />

import * as assert from 'assert';
import { chooseRootPath, createProjectTree, isProjectFile, projectFolderPaths } from '../../apps/standalone/src/browser-project';
import { BrowserFileProvider, BrowserUri } from '../../apps/standalone/src/browser-file-provider';
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
});
