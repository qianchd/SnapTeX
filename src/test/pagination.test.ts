import * as assert from 'assert';
import { PageLayoutController, paginateBlockHeights, type PageMetrics } from '../webview/pagination';
import { ViewportAnchorController } from '../webview/viewport';
import { BlockVirtualizationController } from '../webview/virtualization';

class FakeElement {
    private readonly classes: Set<string>;
    private readonly styles: Map<string, string>;
    readonly classList = {
        contains: (name: string) => this.classes.has(name),
        add: (name: string) => {this.classes.add(name);},
        remove: (name: string) => {this.classes.delete(name);},
        toggle: (name: string, enabled: boolean) => {
            if (enabled) {this.classes.add(name);} else {this.classes.delete(name);}
            return enabled;
        }
    };
    readonly style = {
        getPropertyValue: (name: string) => this.styles.get(name) ?? '',
        setProperty: (name: string, value: string) => {this.styles.set(name, value);},
        removeProperty: (name: string) => {
            const value = this.styles.get(name) ?? '';
            this.styles.delete(name);
            return value;
        }
    };
    readonly children: FakeElement[] = [];
    parentElement: FakeElement | null = null;

    constructor(classes: string[] = [], styles: Record<string, string> = {}, private width = 210) {
        this.classes = new Set(classes);
        this.styles = new Map(Object.entries(styles));
    }

    getBoundingClientRect() {
        return { width: this.width };
    }
}

suite('Paged preview layout', () => {
    const metrics: PageMetrics = {
        pageHeight: 1000,
        topMargin: 100,
        idealBottomMargin: 100,
        minBottomMargin: 50,
        maxBottomMargin: 200
    };

    function pageItem(classes: string[] = [], styles: Record<string, string> = {}): HTMLElement {
        return new FakeElement(classes, styles) as unknown as HTMLElement;
    }

    function withPaginationDom<T>(items: HTMLElement[], run: (controller: PageLayoutController) => T): T {
        const globals = globalThis as unknown as Record<string, unknown>;
        const names = ['HTMLElement', 'document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'];
        const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        const body = pageItem() as unknown as FakeElement;
        const root = new FakeElement([], {}, 210);
        const parent = pageItem() as unknown as FakeElement;
        root.parentElement = parent;
        root.children.push(...items as unknown as FakeElement[]);
        Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: FakeElement });
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: { body, documentElement: pageItem() }
        });
        Object.defineProperty(globalThis, 'getComputedStyle', {
            configurable: true,
            value: () => ({ fontSize: '16px', getPropertyValue: () => '' })
        });
        Object.defineProperty(globalThis, 'requestAnimationFrame', {
            configurable: true,
            value: () => 1
        });
        Object.defineProperty(globalThis, 'cancelAnimationFrame', {
            configurable: true,
            value: () => undefined
        });
        const anchor = { preserve: (_elements: HTMLElement[], update: () => void) => update() };
        const controller = new PageLayoutController(root as unknown as HTMLElement, anchor as ViewportAnchorController);
        try {
            controller.setEnabled(true);
            return run(controller);
        } finally {
            controller.setEnabled(false);
            for (const name of names) {
                const descriptor = previous.get(name);
                if (descriptor) {Object.defineProperty(globalThis, name, descriptor);}
                else {delete globals[name];}
            }
        }
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
        withPaginationDom([oldLast, nextPage], controller => {
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
    });

    test('publishes incremental heights at an existing page boundary and ignores cancelled results', () => {
        const items = [
            pageItem(['latex-block', 'snaptex-page-start']),
            pageItem(['latex-block', 'snaptex-page-end']),
            pageItem(['latex-block', 'snaptex-page-start'], {'--snaptex-page-before': '10%' }),
            pageItem(['latex-block', 'snaptex-page-end'])
        ];
        withPaginationDom(items, controller => {
            assert.equal(controller.beginIncremental(0, 1), 0);
            assert.equal(controller.acceptHeight(0, 130), false);
            assert.equal(controller.acceptHeight(1, 130), false);
            const completed = controller.acceptHeight(2, 130);
            assert.equal(completed, true, 'A valid old boundary after the edit should finish the prefix');
            assert.deepEqual(items.map(item => [
                item.classList.contains('snaptex-page-start'), item.classList.contains('snaptex-page-end')
            ]), [[true, false], [false, true], [true, false], [false, true]]);

            controller.beginIncremental(0, 1);
            controller.cancelIncremental();
            assert.equal(controller.acceptHeight(0, 200), false, 'Cancelled measurement results must not update pagination');
            assert.equal(items[0].classList.contains('snaptex-page-end'), false);
            assert.equal(items[2].classList.contains('snaptex-page-start'), true);
        });
    });

    test('reuses heights only when the paper content width remains compatible', () => {
        const virtualization = new BlockVirtualizationController({} as HTMLElement, new ViewportAnchorController());
        const block = { getAttribute: (name: string) => name === 'data-block-hash' ? 'block-a' : null } as HTMLElement;
        virtualization.setFontSize(20);
        assert.equal(virtualization.getCachedBlockHeight('block-a'), undefined);
        virtualization.cacheBlockHeight('block-a', 0, 20, 1000, true);
        assert.equal(virtualization.getCachedBlockHeight('block-a'), 0);
        assert.equal(virtualization.hasMeasuredHeight(block, 1000), true);
        virtualization.cacheBlockHeight('block-a', 100, 20, 1000, false);
        assert.equal(virtualization.hasMeasuredHeight(block, 1000), false);
        virtualization.cacheBlockHeight('block-a', 100, 20, 1000, true);

        assert.equal(virtualization.hasMeasuredHeight(block, 1004), true);
        assert.equal(virtualization.hasMeasuredHeight(block, 1006), false);

        virtualization.setFontSize(25);
        assert.equal(virtualization.hasMeasuredHeight(block, 1250), true);
        assert.equal(virtualization.getCachedBlockHeight('block-a'), 125);
    });

    test('scopes cached HTML to each shell and releases observers on reset', () => {
        const shells = new Map<string, HTMLElement>();
        const contentRoot = {
            querySelector: (selector: string) => shells.get(selector.match(/data-index="(\d+)"/)?.[1] ?? '')
        } as HTMLElement;
        const virtualization = new BlockVirtualizationController(contentRoot, new ViewportAnchorController());
        let disconnects = 0;
        let observations = 0;
        Object.assign(virtualization, { resizeObserver: {
            observe: () => {observations++;},
            disconnect: () => {disconnects++;}
        } });
        const shell = (index: string) => ({
            getAttribute: (name: string) => name === 'data-index' ? index : name === 'data-block-hash' ? 'same-hash' : null
        }) as HTMLElement;
        shells.set('1', shell('1'));
        shells.set('2', shell('2'));

        virtualization.storeBlockHtml(1, 'same-hash', '<div data-index="1">first</div>');
        virtualization.storeBlockHtml(2, 'same-hash', '<div data-index="2">second</div>');

        assert.match(virtualization.getBlockHtml(shells.get('1')), /first/);
        assert.match(virtualization.getBlockHtml(shells.get('2')), /second/);
        virtualization.observeShell(shells.get('1'));
        virtualization.observeShell(shells.get('2'));
        virtualization.resetCaches();
        assert.equal(disconnects, 1);
        virtualization.observeShell(shells.get('1'));
        assert.equal(observations, 3, 'Reset must release shells so they can be observed again');
        assert.equal(virtualization.getBlockHtml(shells.get('1')), undefined);
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
            const virtualization = new BlockVirtualizationController({} as HTMLElement, controller);
            let enumerations = 0;
            virtualization.getShells = () => {enumerations++; return elements;};
            controller.pin(elements);
            layoutShift = 30;
            virtualization.withViewportAnchorPreserved(() => undefined, undefined);
            assert.equal(scrollDelta, 30);
            assert.equal(enumerations, 0, 'A valid pinned anchor needs no shell enumeration');
            assert.ok(rectReads < 40, `Expected logarithmic anchor lookup, read ${rectReads} rectangles`);

            controller.clear();
            virtualization.withViewportAnchorPreserved(() => {layoutShift += 20;}, undefined);
            assert.equal(scrollDelta, 20);
            assert.equal(enumerations, 1, 'Without a pin, find a fresh visible anchor');

            window.scrollY = 0;
            virtualization.withViewportAnchorPreserved(() => undefined, undefined);
            assert.equal(enumerations, 1, 'The document top needs no scroll compensation');
        } finally {
            if (previousWindow) {
                Object.defineProperty(globalThis, 'window', previousWindow);
            } else {
                delete (globalThis as { window?: unknown }).window;
            }
        }
    });
});
