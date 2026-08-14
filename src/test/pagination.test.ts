import * as assert from 'assert';
import { paginateBlockHeights, type PageMetrics } from '../webview/pagination';

suite('Paged preview layout', () => {
    const metrics: PageMetrics = {
        pageHeight: 1000,
        topMargin: 100,
        idealBottomMargin: 100,
        minBottomMargin: 50,
        maxBottomMargin: 200,
        gap: 20
    };

    test('retains existing page boundaries while edits fit the elastic margin', () => {
        const pages = paginateBlockHeights([380, 350, 350, 350], metrics, [0, 2]);

        assert.deepEqual(pages.map(page => [page.start, page.end]), [[0, 2], [2, 4]]);
    });

    test('repaginates only when a page exceeds its hard capacity', () => {
        const pages = paginateBlockHeights([550, 350, 300], metrics, [0, 2]);

        assert.deepEqual(pages.map(page => [page.start, page.end]), [[0, 1], [1, 3]]);
    });

    test('keeps an oversized block intact on an extended page', () => {
        const pages = paginateBlockHeights([900, 200], metrics);

        assert.deepEqual(pages.map(page => [page.start, page.end]), [[0, 1], [1, 2]]);
        assert.equal(pages[0].extended, true);
        assert.equal(pages[0].pageHeight, 1100);
    });
});
