/// <reference types="mocha" />
import * as assert from 'assert';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { gunzipSync } from 'zlib';
import { mapSyncTeXInputs, PdfSyncIndex } from '../../apps/standalone/src/pdf-sync-index';

const root = resolve(__dirname, '../../..');
const runtimeUrl = pathToFileURL(resolve(root, 'apps/standalone/vendor/synctex/synctex.mjs')).href;

suite('Offline PDF SyncTeX', () => {
    test('queries real compiled text, math, table cells and included files without a server', async () => {
        const data = await readFile(resolve(root, 'src/test/fixtures/synctex/document.synctex.gz'));
        // Golden coordinates from the native synctex CLI on the accompanying TeX sources.
        for (const compressed of [true, false]) {
            const index = await PdfSyncIndex.open(runtimeUrl, compressed ? data : gunzipSync(data), compressed,
                '/document.pdf', '/document.tex', ['/document.tex', '/sections/body.tex']);
            try {
                for (const [sourcePath, line, page, x, y, inverseLine] of [
                    ['/document.tex', 4, 1, 169.689255, 134.764618, 4],
                    ['/document.tex', 6, 1, 284.870148, 156.682419, 7],
                    ['/document.tex', 10, 2, 179.153778, 139.247803, 10],
                    ['/document.tex', 12, 2, 326.656403, 133.170563, 12],
                    ['/sections/body.tex', 1, 1, 174.449203, 178.600235, 1]
                ] as const) {
                    const point = index.query({ direction: 'forward', sourcePath, line, column: 1 });
                    assert.ok(point && 'page' in point);
                    assert.equal(point.page, page);
                    assert.ok(Math.abs(point.x - x) < 0.001 && Math.abs(point.y - y) < 0.001);
                    assert.deepEqual(index.query({ direction: 'inverse', page, x, y }),
                        { path: sourcePath, line: inverseLine, column: 1 });
                }
                assert.equal(index.query({ direction: 'forward', sourcePath: '/outside.tex', line: 1, column: 1 }), undefined);
            } finally {index.close();}
        }
        await assert.rejects(PdfSyncIndex.open(runtimeUrl, new TextEncoder().encode('not SyncTeX'), false,
            '/document.pdf', '/document.tex', ['/document.tex']), /Invalid SyncTeX/);
    });

    test('maps only known project paths, including parent-relative input, without ambiguous basename fallback', () => {
        const paths = ['/sub/root.tex', '/one/body.tex', '/two/body.tex'];
        assert.deepEqual([...mapSyncTeXInputs(new Map([
            [1, './root.tex'], [2, '../one/body.tex'], [3, '../../outside.tex'], [4, '/etc/body.tex']
        ]), '/sub/root.pdf', '/sub/root.tex', paths)], [[1, '/sub/root.tex'], [2, '/one/body.tex']]);
        assert.deepEqual([...mapSyncTeXInputs(new Map([
            [1, 'C:\\compile\\sub\\root.tex'], [2, 'C:\\compile\\two\\body.tex'], [3, 'C:\\outside\\body.tex']
        ]), '/sub/root.pdf', '/sub/root.tex', paths)], [[1, '/sub/root.tex'], [2, '/two/body.tex']]);
        assert.equal(mapSyncTeXInputs(new Map([[1, '/a/sub/root.tex'], [2, '/b/sub/root.tex']]),
            '/sub/root.pdf', '/sub/root.tex', paths).size, 0);
    });
});
