import { PREVIEW_RESIZE_ACTIVE_CLASS, type ViewportAnchorController } from './viewport';

const PAGE_ASPECT_RATIO = 297 / 210;
const PAGE_TOP_MARGIN_RATIO = 24 / 210;
const PAGE_BOTTOM_MARGIN_RATIO = 16 / 210;
const PAGE_MIN_BOTTOM_MARGIN_RATIO = 6 / 210;
const PAGE_MAX_BOTTOM_MARGIN_RATIO = 30 / 210;
const PAGE_SIDE_MARGIN_RATIO = 18 / 210;
const PAGE_CONTENT_WIDTH_RATIO = 1 - 2 * PAGE_SIDE_MARGIN_RATIO;

export interface PageMetrics {
    pageHeight: number;
    topMargin: number;
    idealBottomMargin: number;
    minBottomMargin: number;
    maxBottomMargin: number;
}

interface PageRange {
    start: number;
    end: number;
    usedHeight: number;
    pageHeight: number;
}

interface IncrementalLayout {
    items: HTMLElement[];
    lastChanged: number;
    oldStartIndices: number[];
    pendingStart: number;
    pendingHeights: number[];
    pages: PageRange[];
    metrics: PageMetrics;
    pageWidth: number;
}

function setStyleProperty(element: HTMLElement, property: string, value: string): void {
    if (element.style.getPropertyValue(property) !== value) { element.style.setProperty(property, value); }
}

function createPage(start: number, end: number, usedHeight: number, metrics: PageMetrics): PageRange {
    return {
        start,
        end,
        usedHeight,
        pageHeight: end === start + 1 && usedHeight > metrics.pageHeight - metrics.topMargin - metrics.minBottomMargin
            ? metrics.topMargin + usedHeight + metrics.idealBottomMargin
            : metrics.pageHeight
    };
}

function retainPage(heights: readonly number[], start: number, end: number, metrics: PageMetrics, isLast: boolean): PageRange | undefined {
    if (end <= start) {return undefined;}
    const hardCapacity = metrics.pageHeight - metrics.topMargin - metrics.minBottomMargin;
    let usedHeight = 0;
    for (let index = start; index < end; index++) {
        usedHeight += heights[index];
    }
    if (usedHeight > hardCapacity && end !== start + 1) {return undefined;}
    if (!isLast && usedHeight < metrics.pageHeight - metrics.topMargin - metrics.maxBottomMargin) {return undefined;}
    return createPage(start, end, usedHeight, metrics);
}

function createGreedyPage(heights: readonly number[], start: number, metrics: PageMetrics): PageRange {
    const idealCapacity = metrics.pageHeight - metrics.topMargin - metrics.idealBottomMargin;
    const hardCapacity = metrics.pageHeight - metrics.topMargin - metrics.minBottomMargin;
    const minimumFill = metrics.pageHeight - metrics.topMargin - metrics.maxBottomMargin;
    if (heights[start] > hardCapacity) {return createPage(start, start + 1, heights[start], metrics);}

    let end = start;
    let usedHeight = 0;
    while (end < heights.length) {
        const candidate = usedHeight + heights[end];
        if (candidate > hardCapacity) {break;}
        if (end > start && candidate > idealCapacity && usedHeight >= minimumFill) {break;}
        usedHeight = candidate;
        end += 1;
    }
    return createPage(start, end, usedHeight, metrics);
}

/**
 * Packs atomic preview blocks into pages while retaining valid existing page
 * starts. The generous bottom-margin band absorbs small edits without moving
 * blocks between pages; a block taller than one page receives an extended page.
 */
export function paginateBlockHeights(
    heights: readonly number[],
    metrics: PageMetrics,
    preferredStarts: readonly number[] = []
): PageRange[] {
    const preferred = new Set(preferredStarts.filter(index => index > 0 && index < heights.length));
    const starts = [0, ...preferred].sort((a, b) => a - b);
    const pages: PageRange[] = [];
    let cursor = 0;
    let preferredCursor = 0;

    while (cursor < heights.length) {
        while (starts[preferredCursor] <= cursor) {preferredCursor += 1;}
        const nextPreferred = starts[preferredCursor];
        const preferredEnd = nextPreferred ?? heights.length;
        const retained = cursor === 0 || preferred.has(cursor)
            ? retainPage(heights, cursor, preferredEnd, metrics, preferredEnd === heights.length)
            : undefined;
        const page = retained ?? createGreedyPage(heights, cursor, metrics);
        pages.push(page);
        cursor = page.end;
    }

    return pages;
}

function offsetPages(pages: readonly PageRange[], offset: number): PageRange[] {
    return pages.map(page => ({ ...page, start: page.start + offset, end: page.end + offset }));
}

/** Applies optional page-like layout without changing the rendered block DOM. */
export class PageLayoutController {
    private enabled = false;
    private forceMeasure = true;
    private scheduledFrame: number | undefined;
    private readonly heights = new WeakMap<Element, number>();
    private readonly resizeObserver?: ResizeObserver;
    private readonly observedItems = new Set<HTMLElement>();
    private readonly resizedItems = new Set<HTMLElement>();
    private incrementalLayout?: IncrementalLayout;

    constructor(
        private readonly contentRoot: HTMLElement,
        private readonly viewportAnchor: ViewportAnchorController
    ) {
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(entries => {
                if (document.body.classList.contains(PREVIEW_RESIZE_ACTIVE_CLASS)
                    || this.contentRoot.getBoundingClientRect().width <= 0) {return;}
                entries.forEach(entry => {
                    const height = Math.ceil(entry.contentRect.height);
                    const expectedHeight = this.heights.get(entry.target);
                    if (expectedHeight !== undefined && Math.abs(expectedHeight - height) <= 1) {return;}
                    this.heights.set(entry.target, height);
                    this.resizedItems.add(entry.target as HTMLElement);
                });
                this.repaginateResizedItems();
            });
        }
    }

    setEnabled(enabled: boolean): void {
        if (this.enabled === enabled) {return;}
        this.enabled = enabled;
        document.body.classList.toggle('snaptex-paged-preview', enabled);
        (this.contentRoot.parentElement ?? document.body).classList.toggle('snaptex-page-host', enabled);
        if (!enabled) {
            this.clearLayout();
            return;
        }
        this.forceMeasure = true;
        this.schedule();
    }

    refresh(forceMeasure = false): void {
        if (!this.enabled) {return;}
        this.forceMeasure ||= forceMeasure;
        this.schedule();
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    syncContentWidth(): number | undefined {
        if (!this.enabled) {return undefined;}
        const pageWidth = this.contentRoot.getBoundingClientRect().width;
        if (pageWidth <= 0) {return undefined;}
        this.updatePageSideMargin(this.getItems(), pageWidth);
        return pageWidth * PAGE_CONTENT_WIDTH_RATIO;
    }

    rescaleHeights(scale: number): void {
        if (!this.enabled || !Number.isFinite(scale) || scale <= 0) {return;}
        this.getItems().forEach(item => {
            const height = this.heights.get(item);
            if (height !== undefined) {this.heights.set(item, height * scale);}
        });
        this.resizedItems.clear();
        this.forceMeasure = false;
    }

    getPageStartIndex(index: number): number {
        const items = this.getItems();
        for (let cursor = Math.min(index, items.length - 1); cursor > 0; cursor--) {
            if (items[cursor].classList.contains('snaptex-page-start')) {return cursor;}
        }
        return 0;
    }

    /** Keeps the current page edges visible until an edited range is repaginated. */
    transferPatchLayout(
        previous: readonly HTMLElement[],
        next: readonly HTMLElement[],
        before?: HTMLElement | null,
        after?: HTMLElement | null
    ): void {
        if (!this.enabled) {return;}
        if (previous.length === 0) {
            if (next.length === 0) {return;}
            if (before?.classList.contains('snaptex-page-end')) {
                this.moveItemLayout(before, next[next.length - 1], false, true);
            } else if (after) {
                this.moveItemLayout(after, next[0], true, false);
            }
            return;
        }
        if (next.length === 0) {
            if (after) {this.moveItemLayout(previous[0], after, true, false);}
            if (before) {
                this.moveItemLayout(previous[previous.length - 1], before, false, true);
            }
            return;
        }
        if (previous.length === next.length) {
            previous.forEach((item, index) => this.moveItemLayout(item, next[index], true, true));
            return;
        }
        this.moveItemLayout(previous[0], next[0], true, false);
        this.moveItemLayout(previous[previous.length - 1], next[next.length - 1], false, true);
    }

    beginIncremental(startIndex: number, lastChangedIndex: number): number {
        if (!this.enabled) {return Math.max(0, startIndex);}
        if (this.scheduledFrame !== undefined) {
            cancelAnimationFrame(this.scheduledFrame);
            this.scheduledFrame = undefined;
        }
        const items = this.getItems();
        if (items.length === 0) {
            this.incrementalLayout = undefined;
            return 0;
        }
        this.pruneObservedItems(items);
        const start = Math.min(Math.max(0, startIndex), items.length - 1);
        const oldStartIndices = items
            .map((item, index) => item.classList.contains('snaptex-page-start') ? index : -1)
            .filter(index => index >= start);
        const pageWidth = this.contentRoot.getBoundingClientRect().width;
        if (pageWidth <= 0) {
            this.incrementalLayout = undefined;
            return start;
        }
        this.updatePageSideMargin(items, pageWidth);
        this.incrementalLayout = {
            items,
            lastChanged: Math.max(start, lastChangedIndex),
            oldStartIndices,
            pendingStart: start,
            pendingHeights: [],
            pages: [],
            metrics: this.getMetrics(pageWidth),
            pageWidth
        };
        return start;
    }

    acceptHeight(index: number, height: number): boolean {
        const layout = this.incrementalLayout;
        if (!layout || index !== layout.pendingStart + layout.pendingHeights.length) {return false;}

        this.rememberHeight(layout.items[index], height);
        this.resizedItems.delete(layout.items[index]);
        layout.pendingHeights.push(height);
        const preferredStarts = layout.oldStartIndices
            .filter(start => start > layout.pendingStart)
            .map(start => start - layout.pendingStart);
        const pendingPages = paginateBlockHeights(layout.pendingHeights, layout.metrics, preferredStarts);
        if (pendingPages.length < 2) {return false;}

        const lastPage = pendingPages[pendingPages.length - 1];
        layout.pages.push(...offsetPages(pendingPages.slice(0, -1), layout.pendingStart));
        layout.pendingHeights = layout.pendingHeights.slice(lastPage.start);
        layout.pendingStart += lastPage.start;
        if (layout.pendingStart > layout.lastChanged
            && layout.oldStartIndices.includes(layout.pendingStart)) {
            this.completeIncremental(true);
            return true;
        }
        this.publishIncrementalPages(layout, true);
        return false;
    }

    finishIncremental(): void {
        const layout = this.incrementalLayout;
        if (!layout) {return;}
        layout.pages.push(...offsetPages(
            paginateBlockHeights(layout.pendingHeights, layout.metrics),
            layout.pendingStart
        ));
        this.completeIncremental(false);
    }

    cancelIncremental(): void {
        this.incrementalLayout = undefined;
    }

    reset(): void {
        this.forceMeasure = true;
        this.clearLayout();
        if (this.enabled) {this.schedule();}
    }

    private getItems(): HTMLElement[] {
        const items: HTMLElement[] = [];
        for (let index = 0; index < this.contentRoot.children.length; index++) {
            const element = this.contentRoot.children[index];
            if (element instanceof HTMLElement
                && (element.classList.contains('latex-block') || element.classList.contains('latex-block-shell'))) {
                items.push(element);
            }
        }
        return items;
    }

    private schedule(): void {
        if (this.incrementalLayout || this.scheduledFrame !== undefined) {return;}
        this.scheduledFrame = requestAnimationFrame(() => {
            this.scheduledFrame = undefined;
            this.layout();
        });
    }

    private measure(items: readonly HTMLElement[]): number[] {
        const forceMeasure = this.forceMeasure;
        this.forceMeasure = false;
        this.pruneObservedItems(items);
        return items.map(item => {
            const cached = forceMeasure ? undefined : this.heights.get(item);
            const height = cached ?? Math.ceil(Math.max(item.getBoundingClientRect().height, item.scrollHeight));
            this.rememberHeight(item, height);
            return height;
        });
    }

    private pruneObservedItems(items: readonly HTMLElement[]): void {
        const currentItems = new Set(items);
        this.observedItems.forEach(item => {
            if (currentItems.has(item)) {return;}
            this.resizeObserver?.unobserve(item);
            this.observedItems.delete(item);
            this.resizedItems.delete(item);
        });
    }

    private rememberHeight(item: HTMLElement, height: number): void {
        this.heights.set(item, height);
        if (this.resizeObserver && !this.observedItems.has(item)) {
            this.resizeObserver.observe(item);
            this.observedItems.add(item);
        }
    }

    private repaginateResizedItems(): void {
        if (!this.enabled || this.incrementalLayout || this.resizedItems.size === 0) {return;}
        const items = this.getItems();
        let first = items.length;
        let last = -1;
        items.forEach((item, index) => {
            if (!this.resizedItems.delete(item)) {return;}
            first = Math.min(first, index);
            last = index;
        });
        this.resizedItems.clear();
        if (last < 0) {return;}

        while (first > 0 && !items[first].classList.contains('snaptex-page-start')) {first -= 1;}
        let index = this.beginIncremental(first, last);
        for (; index < items.length; index++) {
            const height = this.heights.get(items[index]);
            if (height === undefined) {
                this.cancelIncremental();
                this.forceMeasure = true;
                this.schedule();
                return;
            }
            if (this.acceptHeight(index, height)) {return;}
        }
        this.finishIncremental();
    }

    private getMetrics(pageWidth: number): PageMetrics {
        return {
            pageHeight: pageWidth * PAGE_ASPECT_RATIO,
            topMargin: pageWidth * PAGE_TOP_MARGIN_RATIO,
            idealBottomMargin: pageWidth * PAGE_BOTTOM_MARGIN_RATIO,
            minBottomMargin: pageWidth * PAGE_MIN_BOTTOM_MARGIN_RATIO,
            maxBottomMargin: pageWidth * PAGE_MAX_BOTTOM_MARGIN_RATIO
        };
    }

    private updatePageSideMargin(items: readonly HTMLElement[], pageWidth: number): void {
        const host = this.contentRoot.parentElement ?? document.body;
        const sideMargin = `${pageWidth * PAGE_SIDE_MARGIN_RATIO}px`;
        if (host.style.getPropertyValue('--snaptex-page-side-margin') !== sideMargin) {
            this.viewportAnchor.preserve(items, () => setStyleProperty(host, '--snaptex-page-side-margin', sideMargin));
        }
    }

    private moveItemLayout(
        previous: HTMLElement,
        next: HTMLElement,
        start: boolean,
        end: boolean
    ): void {
        if (start && previous.classList.contains('snaptex-page-start')) {
            next.classList.add('snaptex-page-start');
            setStyleProperty(next, '--snaptex-page-before', previous.style.getPropertyValue('--snaptex-page-before'));
            previous.classList.remove('snaptex-page-start');
            previous.style.removeProperty('--snaptex-page-before');
        }
        if (end && previous.classList.contains('snaptex-page-end')) {
            next.classList.add('snaptex-page-end');
            setStyleProperty(next, '--snaptex-page-after', previous.style.getPropertyValue('--snaptex-page-after'));
            previous.classList.remove('snaptex-page-end');
            previous.style.removeProperty('--snaptex-page-after');
        }
    }

    private layout(): void {
        if (!this.enabled) {return;}
        const items = this.getItems();
        if (items.length === 0) {
            this.clearLayout();
            return;
        }

        const pageWidth = this.contentRoot.getBoundingClientRect().width;
        if (pageWidth <= 0) {return;}
        this.updatePageSideMargin(items, pageWidth);
        const metrics = this.getMetrics(pageWidth);
        const preferredStarts = items
            .map((item, index) => item.classList.contains('snaptex-page-start') ? index : -1)
            .filter(index => index >= 0);
        const pages = paginateBlockHeights(this.measure(items), metrics, preferredStarts);
        this.viewportAnchor.preserve(items, () => this.applyPages(items, pages, metrics, pageWidth, 0, false));
    }

    private completeIncremental(reuseSuffix: boolean): void {
        const layout = this.incrementalLayout;
        if (!layout) {return;}
        this.publishIncrementalPages(layout, reuseSuffix);
        this.incrementalLayout = undefined;
        this.repaginateResizedItems();
    }

    private publishIncrementalPages(layout: IncrementalLayout, reuseSuffix: boolean): void {
        const pages = layout.pages;
        if (pages.length === 0) {return;}
        layout.pages = [];
        this.viewportAnchor.preserve(layout.items, () => this.applyPages(
            layout.items,
            pages,
            layout.metrics,
            layout.pageWidth,
            pages[0].start,
            reuseSuffix
        ));
    }

    private applyPages(
        items: readonly HTMLElement[],
        pages: readonly PageRange[],
        metrics: PageMetrics,
        pageWidth: number,
        start: number,
        reuseSuffix: boolean
    ): void {
        const end = pages[pages.length - 1]?.end ?? start;
        const contentWidth = pageWidth * PAGE_CONTENT_WIDTH_RATIO;
        const toContentWidthPercent = (height: number) => `${height / contentWidth * 100}%`;
        const topMargin = toContentWidthPercent(metrics.topMargin);
        for (let index = start; index < end; index++) {
            const item = items[index];
            item.classList.remove('snaptex-page-start', 'snaptex-page-end');
            item.style.removeProperty('--snaptex-page-before');
            item.style.removeProperty('--snaptex-page-after');
        }
        for (const page of pages) {
            const first = items[page.start];
            const last = items[page.end - 1];
            first.classList.add('snaptex-page-start');
            last.classList.add('snaptex-page-end');
            setStyleProperty(first, '--snaptex-page-before', topMargin);
            setStyleProperty(last, '--snaptex-page-after', toContentWidthPercent(
                page.pageHeight - metrics.topMargin - page.usedHeight
            ));
        }
        if (reuseSuffix && pages.length > 0 && end < items.length) {
            const item = items[end];
            item.classList.add('snaptex-page-start');
            setStyleProperty(item, '--snaptex-page-before', topMargin);
            if (!item.classList.contains('snaptex-page-end')) {
                for (let index = end + 1; index < items.length; index++) {
                    const suffixItem = items[index];
                    suffixItem.classList.remove('snaptex-page-start');
                    suffixItem.style.removeProperty('--snaptex-page-before');
                    if (suffixItem.classList.contains('snaptex-page-end')) {break;}
                }
            }
        }
    }

    private clearLayout(): void {
        if (this.scheduledFrame !== undefined) {
            cancelAnimationFrame(this.scheduledFrame);
            this.scheduledFrame = undefined;
        }
        this.incrementalLayout = undefined;
        this.resizeObserver?.disconnect();
        this.observedItems.clear();
        this.resizedItems.clear();
        this.getItems().forEach(item => {
            item.classList.remove('snaptex-page-start', 'snaptex-page-end');
            item.style.removeProperty('--snaptex-page-before');
            item.style.removeProperty('--snaptex-page-after');
        });
        const host = this.contentRoot.parentElement ?? document.body;
        host.style.removeProperty('--snaptex-page-side-margin');
    }
}
