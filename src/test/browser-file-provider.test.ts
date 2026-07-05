/// <reference types="mocha" />

import * as assert from 'assert';
import { BrowserFileProvider, BrowserUri, normalizeBrowserPath, type BrowserWritableFileHandle } from '../../apps/standalone/src/browser-file-provider';
import { PreviewUpdateService } from '../preview-update-service';
import { SmartRenderer } from '../renderer';

suite('BrowserFileProvider', () => {
    test('normalizes paths and resolves relative files from a directory', () => {
        const provider = new BrowserFileProvider();
        const rootUri = new BrowserUri('/project/main.tex');

        assert.equal(normalizeBrowserPath('project/sections/../main.tex'), '/project/main.tex');
        assert.equal(provider.dir(rootUri).path, '/project');
        assert.equal(provider.resolve(provider.dir(rootUri), 'sections/intro.tex').path, '/project/sections/intro.tex');
    });

    test('stores project files and writes back through browser handles', async () => {
        let writtenText = '';
        let closed = false;
        const handle: BrowserWritableFileHandle = {
            async createWritable() {
                return {
                    write(data: string) {
                        writtenText = data;
                    },
                    close() {
                        closed = true;
                    }
                };
            }
        };
        const provider = new BrowserFileProvider();
        const uri = new BrowserUri('/main.tex');

        provider.setProjectFiles([{ path: 'main.tex', text: 'old', handle }]);
        const wrote = await provider.write(uri, 'new');

        assert.equal(wrote, true);
        assert.equal(await provider.read(uri), 'new');
        assert.equal(writtenText, 'new');
        assert.equal(closed, true);
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
                text: 'Included paragraph.'
            }
        ]);
        const service = new PreviewUpdateService(provider, new SmartRenderer());

        const payload = await service.render(rootUri, await provider.read(rootUri), { deferFullHtml: false });

        assert.match(payload.htmls?.join('\n') ?? '', /Included paragraph/);
    });
});
