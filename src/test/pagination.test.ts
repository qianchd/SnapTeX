import * as assert from 'assert';
import { PageLayoutController, paginateBlockHeights, type PageMetrics } from '../webview/pagination';
import { ViewportAnchorController } from '../webview/viewport';
import { BlockVirtualizationController } from '../webview/virtualization';

suite('Paged preview layout', () => {
    const metrics: PageMetrics = {
        pageHeight: 1000,
        topMargin: 100,
        idealBottomMargin: 100,
        minBottomMargin: 50,
        maxBottomMargin: 200
    };

    function pageItem(classes: string[] = [], styles: Record<string, string> = {}): HTMLElement {
        const classNames = new Set(classes);
        const properties = new Map(Object.entries(styles));
        return {
            classList: {
                contains: (name: string) => classNames.has(name),
                add: (name: string) => {classNames.add(name);},
                remove: (name: string) => {classNames.delete(name);}
            },
            style: {
                getPropertyValue: (name: string) => properties.get(name) ?? '',
                setProperty: (name: string, value: string) => {properties.set(name, value);},
                removeProperty: (name: string) => {
                    const value = properties.get(name) ?? '';
                    properties.delete(name);
                    return value;
                }
            }
        } as unknown as HTMLElement;
    }

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
        assert.equal(pages[0].pageHeight, 1100);
    });

    test('moves the existing page margin to a block inserted at the page boundary', () => {
        const oldLast = pageItem(['snaptex-page-end'], {'--snaptex-page-after': '42%'});
        const inserted = pageItem();
        const nextPage = pageItem(['snaptex-page-start'], {'--snaptex-page-before': '10%'});
        const controller = new PageLayoutController({} as HTMLElement, new ViewportAnchorController());
        (controller as unknown as { enabled: boolean }).enabled = true;

        controller.transferPatchLayout([], [inserted], oldLast, nextPage);

        assert.equal(oldLast.classList.contains('snaptex-page-end'), false);
        assert.equal(inserted.classList.contains('snaptex-page-end'), true);
        assert.equal(inserted.classList.contains('snaptex-page-start'), false);
        assert.equal(nextPage.classList.contains('snaptex-page-start'), true);
        assert.equal(inserted.style.getPropertyValue('--snaptex-page-after'), '42%');

        const edited = pageItem();
        controller.transferPatchLayout([inserted], [edited]);
        assert.equal(edited.style.getPropertyValue('--snaptex-page-after'), '42%');
    });

    test('removes stale page starts when incremental pagination publishes a new boundary', () => {
        const items = [
            pageItem(['snaptex-page-start']),
            pageItem(),
            pageItem(['snaptex-page-start'], {'--snaptex-page-before': '10%'}),
            pageItem(['snaptex-page-end'])
        ];
        const viewport = {preserve: (_items: HTMLElement[], update: () => void) => update()};
        const controller = new PageLayoutController({} as HTMLElement, viewport as ViewportAnchorController);
        const applyPages = (controller as unknown as {applyPages: (...args: unknown[]) => void}).applyPages.bind(controller);

        applyPages(items, [{start: 0, end: 1, usedHeight: 700, pageHeight: 1000}], metrics, 1000, 0, true);

        assert.equal(items[1].classList.contains('snaptex-page-start'), true);
        assert.equal(items[2].classList.contains('snaptex-page-start'), false);
        assert.equal(items[2].style.getPropertyValue('--snaptex-page-before'), '');
    });

    test('reuses heights only when the paper content width remains compatible', () => {
        const virtualization = new BlockVirtualizationController({} as HTMLElement, new ViewportAnchorController());
        const block = { getAttribute: (name: string) => name === 'data-block-hash' ? 'block-a' : null } as HTMLElement;
        virtualization.setFontSize(20);
        virtualization.cacheBlockHeight('block-a', 100, 20, 1000, false);
        assert.equal(virtualization.hasMeasuredHeight(block, 1000), false);
        virtualization.cacheBlockHeight('block-a', 100, 20, 1000, true);

        assert.equal(virtualization.hasMeasuredHeight(block, 1004), true);
        assert.equal(virtualization.hasMeasuredHeight(block, 1006), false);

        virtualization.setFontSize(25);
        assert.equal(virtualization.hasMeasuredHeight(block, 1250), true);
        assert.equal(virtualization.getCachedBlockHeight('block-a'), 125);
    });

    test('preserves a mid-document anchor without scanning the offscreen prefix', () => {
        const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        let layoutShift = 0;
        let rectReads = 0;
        let scrollDelta = 0;
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: {
                innerHeight: 800,
                scrollY: 50_000,
                scrollBy: (_left: number, top: number) => { scrollDelta = top; }
            }
        });
        const elements = Array.from({ length: 2_000 }, (_, index) => ({
            isConnected: true,
            getBoundingClientRect: () => {
                rectReads += 1;
                const top = index * 100 - 50_000 + layoutShift;
                return { top, bottom: top + 100 };
            }
        })) as unknown as HTMLElement[];

        try {
            const controller = new ViewportAnchorController();
            controller.pin(elements);
            layoutShift = 30;
            controller.preserve([], () => undefined);
            assert.equal(scrollDelta, 30);
            assert.ok(rectReads < 40, `Expected logarithmic anchor lookup, read ${rectReads} rectangles`);
        } finally {
            if (previousWindow) {
                Object.defineProperty(globalThis, 'window', previousWindow);
            } else {
                delete (globalThis as { window?: unknown }).window;
            }
        }
    });
});
