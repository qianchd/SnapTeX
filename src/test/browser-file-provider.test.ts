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

    test('loads project text lazily and caches it after the first read', async () => {
        const provider = new BrowserFileProvider();
        const uri = new BrowserUri('/project/lazy.tex');
        let reads = 0;

        provider.setProjectFiles([{
            path: uri.path,
            readText: async () => {
                reads += 1;
                return 'Lazy paragraph.';
            }
        }]);

        const beforeRead = await provider.stat(uri);
        assert.equal(await provider.read(uri), 'Lazy paragraph.');
        assert.equal(await provider.read(uri), 'Lazy paragraph.');
        assert.equal((await provider.stat(uri)).mtime, beforeRead.mtime);
        assert.equal(reads, 1);
    });

    test('stores binary project resources as cached object URLs', async () => {
        const provider = new BrowserFileProvider();
        const uri = new BrowserUri('/figures/result.png');
        const hostUri = new BrowserUri('/figures/android.png');
        let createCalls = 0;

        provider.setProjectFiles([
            { path: uri.path, blob: new Blob(['image-bytes'], { type: 'image/png' }) },
            { path: hostUri.path, resourceUrl: 'https://appassets.androidplatform.net/project/figures/android.png' }
        ]);

        const firstUrl = provider.getResourceUrl(uri, blob => {
            createCalls += 1;
            assert.equal(blob.type, 'image/png');
            return `blob:test-${createCalls}`;
        });
        const secondUrl = provider.getResourceUrl(uri, () => {
            throw new Error('Object URL should be cached.');
        });

        assert.equal(firstUrl, 'blob:test-1');
        assert.equal(secondUrl, 'blob:test-1');
        assert.equal(provider.getResourceUrl(hostUri, () => {
            throw new Error('Host-backed resource URLs should not create object URLs.');
        }), 'https://appassets.androidplatform.net/project/figures/android.png');
        assert.equal(createCalls, 1);
        await assert.rejects(() => provider.read(uri), /Missing browser file/);
    });

    test('clears stale project text and resource URLs when reloading files', async () => {
        const provider = new BrowserFileProvider();
        const oldTextUri = new BrowserUri('/old/main.tex');
        const oldImageUri = new BrowserUri('/old/figure.png');
        const revokedUrls: string[] = [];
        const originalRevokeObjectUrl = URL.revokeObjectURL;

        URL.revokeObjectURL = (url: string) => {
            revokedUrls.push(url);
        };

        try {
            provider.setProjectFiles([
                { path: oldTextUri.path, text: 'Old text.' },
                { path: oldImageUri.path, blob: new Blob(['old-image'], { type: 'image/png' }) }
            ]);
            assert.equal(provider.getResourceUrl(oldImageUri, () => 'blob:old-image'), 'blob:old-image');

            provider.setProjectFiles([{ path: '/new/main.tex', text: 'New text.' }]);

            assert.deepEqual(revokedUrls, ['blob:old-image']);
            assert.equal(provider.getResourceUrl(oldImageUri, () => 'blob:should-not-exist'), undefined);
            await assert.rejects(() => provider.read(oldTextUri), /Missing browser file/);
            assert.equal(await provider.read(new BrowserUri('/new/main.tex')), 'New text.');
        } finally {
            URL.revokeObjectURL = originalRevokeObjectUrl;
        }
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
        const service = new PreviewUpdateService(provider, new SmartRenderer());

        const payload = await service.render(rootUri, await provider.read(rootUri), { deferFullHtml: false });

        assert.match(payload.htmls?.join('\n') ?? '', /Included paragraph/);
    });
});
