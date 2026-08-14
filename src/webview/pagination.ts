const PAGE_ASPECT_RATIO = 297 / 210;
const PAGE_TOP_MARGIN_RATIO = 20 / 210;
const PAGE_BOTTOM_MARGIN_RATIO = 20 / 210;
const PAGE_MIN_BOTTOM_MARGIN_RATIO = 10 / 210;
const PAGE_MAX_BOTTOM_MARGIN_RATIO = 34 / 210;
const PAGE_SIDE_MARGIN_RATIO = 18 / 210;
const PAGE_GAP_RATIO = 5 / 210;

export interface PageMetrics {
    pageHeight: number;
    topMargin: number;
    idealBottomMargin: number;
    minBottomMargin: number;
    maxBottomMargin: number;
    gap: number;
}

export interface PageRange {
    start: number;
    end: number;
    usedHeight: number;
    pageHeight: number;
    extended: boolean;
}

function sumRange(values: readonly number[], start: number, end: number): number {
    let total = 0;
    for (let index = start; index < end; index++) {
        total += values[index];
    }
    return total;
}

function createPage(start: number, end: number, usedHeight: number, metrics: PageMetrics): PageRange {
    const extended = end === start + 1 && usedHeight > metrics.pageHeight - metrics.topMargin - metrics.minBottomMargin;
    return {
        start,
        end,
        usedHeight,
        pageHeight: extended
            ? metrics.topMargin + usedHeight + metrics.idealBottomMargin
            : metrics.pageHeight,
        extended
    };
}

function isStablePage(heights: readonly number[], start: number, end: number, metrics: PageMetrics, isLast: boolean): boolean {
    if (end <= start) {return false;}
    const usedHeight = sumRange(heights, start, end);
    const hardCapacity = metrics.pageHeight - metrics.topMargin - metrics.minBottomMargin;
    if (end === start + 1 && usedHeight > hardCapacity) {return true;}
    for (let index = start; index < end; index++) {
        if (heights[index] > hardCapacity) {return false;}
    }
    if (usedHeight > hardCapacity) {return false;}
    return isLast || usedHeight >= metrics.pageHeight - metrics.topMargin - metrics.maxBottomMargin;
}

function findGreedyPageEnd(heights: readonly number[], start: number, metrics: PageMetrics): number {
    const idealCapacity = metrics.pageHeight - metrics.topMargin - metrics.idealBottomMargin;
    const hardCapacity = metrics.pageHeight - metrics.topMargin - metrics.minBottomMargin;
    const minimumFill = metrics.pageHeight - metrics.topMargin - metrics.maxBottomMargin;
    if (heights[start] > hardCapacity) {return start + 1;}

    let end = start;
    let usedHeight = 0;
    while (end < heights.length) {
        const candidate = usedHeight + heights[end];
        if (candidate > hardCapacity) {break;}
        if (end > start && candidate > idealCapacity && usedHeight >= minimumFill) {break;}
        usedHeight = candidate;
        end += 1;
    }
    return Math.max(start + 1, end);
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
        const canRetain = (cursor === 0 || preferred.has(cursor))
            && isStablePage(heights, cursor, preferredEnd, metrics, preferredEnd === heights.length);
        const end = canRetain ? preferredEnd : findGreedyPageEnd(heights, cursor, metrics);
        pages.push(createPage(cursor, end, sumRange(heights, cursor, end), metrics));
        cursor = end;
    }

    return pages;
}

/** Applies optional page-like layout without changing the rendered block DOM. */
export class PageLayoutController {
    private enabled = false;
    private forceMeasure = true;
    private scheduledFrame: number | undefined;
    private readonly heights = new WeakMap<Element, number>();
    private readonly resizeObserver?: ResizeObserver;
    private readonly observedItems = new Set<HTMLElement>();
    private pageLayer?: HTMLElement;
    private pageLayerSignature = '';

    constructor(private readonly contentRoot: HTMLElement) {
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(entries => {
                let changed = false;
                entries.forEach(entry => {
                    const height = Math.ceil(entry.contentRect.height);
                    if (height <= 0 || this.heights.get(entry.target) === height) {return;}
                    this.heights.set(entry.target, height);
                    changed = true;
                });
                if (changed) {this.schedule();}
            });
        }
    }

    setEnabled(enabled: boolean): void {
        if (this.enabled === enabled) {return;}
        this.enabled = enabled;
        document.body.classList.toggle('snaptex-paged-preview', enabled);
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

    reset(): void {
        this.forceMeasure = true;
        this.clearLayout();
        if (this.enabled) {this.schedule();}
    }

    transferPageStart(source: Element, target: Element): void {
        if (!source.classList.contains('snaptex-page-start')) {return;}
        target.classList.add('snaptex-page-start');
        const spacing = (source as HTMLElement).style.getPropertyValue('--snaptex-page-before');
        if (spacing) {(target as HTMLElement).style.setProperty('--snaptex-page-before', spacing);}
    }

    private getItems(): HTMLElement[] {
        return Array.from(this.contentRoot.children)
            .filter((element): element is HTMLElement => (
                element instanceof HTMLElement
                && (element.classList.contains('latex-block') || element.classList.contains('latex-block-shell'))
            ));
    }

    private schedule(): void {
        if (this.scheduledFrame !== undefined) {return;}
        this.scheduledFrame = requestAnimationFrame(() => {
            this.scheduledFrame = undefined;
            this.layout();
        });
    }

    private measure(items: readonly HTMLElement[]): number[] {
        const forceMeasure = this.forceMeasure;
        this.forceMeasure = false;
        const currentItems = new Set(items);
        this.observedItems.forEach(item => {
            if (currentItems.has(item)) {return;}
            this.resizeObserver?.unobserve(item);
            this.observedItems.delete(item);
        });
        return items.map(item => {
            const cached = forceMeasure ? undefined : this.heights.get(item);
            const height = cached ?? Math.ceil(item.getBoundingClientRect().height || item.scrollHeight || 1);
            this.heights.set(item, height);
            if (this.resizeObserver && !this.observedItems.has(item)) {
                this.resizeObserver.observe(item);
                this.observedItems.add(item);
            }
            return height;
        });
    }

    private getMetrics(pageWidth: number): PageMetrics {
        return {
            pageHeight: pageWidth * PAGE_ASPECT_RATIO,
            topMargin: pageWidth * PAGE_TOP_MARGIN_RATIO,
            idealBottomMargin: pageWidth * PAGE_BOTTOM_MARGIN_RATIO,
            minBottomMargin: pageWidth * PAGE_MIN_BOTTOM_MARGIN_RATIO,
            maxBottomMargin: pageWidth * PAGE_MAX_BOTTOM_MARGIN_RATIO,
            gap: Math.max(16, pageWidth * PAGE_GAP_RATIO)
        };
    }

    private captureViewportAnchor(items: readonly HTMLElement[]): { element: HTMLElement; top: number } | undefined {
        if (window.scrollY <= 0) {return undefined;}
        const element = items.find(item => item.getBoundingClientRect().bottom > 0);
        return element ? { element, top: element.getBoundingClientRect().top } : undefined;
    }

    private restoreViewportAnchor(anchor: { element: HTMLElement; top: number } | undefined): void {
        if (!anchor?.element.isConnected) {return;}
        const delta = anchor.element.getBoundingClientRect().top - anchor.top;
        if (Math.abs(delta) >= 1) {window.scrollBy(0, delta);}
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
        const metrics = this.getMetrics(pageWidth);
        const preferredStarts = items
            .map((item, index) => item.classList.contains('snaptex-page-start') ? index : -1)
            .filter(index => index >= 0);
        const pages = paginateBlockHeights(this.measure(items), metrics, preferredStarts);
        const anchor = this.captureViewportAnchor(items);
        this.applyLayout(items, pages, metrics, pageWidth);
        this.restoreViewportAnchor(anchor);
    }

    private applyLayout(items: readonly HTMLElement[], pages: readonly PageRange[], metrics: PageMetrics, pageWidth: number): void {
        const pageStarts = new Map(pages.map(page => [page.start, page]));
        let previousPage: PageRange | undefined;
        items.forEach((item, index) => {
            const page = pageStarts.get(index);
            if (!page) {
                if (item.classList.contains('snaptex-page-start')) {
                    item.classList.remove('snaptex-page-start');
                    item.style.removeProperty('--snaptex-page-before');
                }
                return;
            }

            const before = previousPage
                ? previousPage.pageHeight - metrics.topMargin - previousPage.usedHeight + metrics.gap + metrics.topMargin
                : metrics.gap + metrics.topMargin;
            const spacing = `${Math.round(Math.max(0, before))}px`;
            item.classList.add('snaptex-page-start');
            if (item.style.getPropertyValue('--snaptex-page-before') !== spacing) {
                item.style.setProperty('--snaptex-page-before', spacing);
            }
            previousPage = page;
        });

        const lastPage = pages[pages.length - 1];
        this.contentRoot.style.setProperty('--snaptex-page-side-margin', `${Math.round(pageWidth * PAGE_SIDE_MARGIN_RATIO)}px`);
        this.contentRoot.style.setProperty('--snaptex-page-tail', `${Math.round(lastPage.pageHeight - metrics.topMargin - lastPage.usedHeight + metrics.gap)}px`);
        this.renderPageLayer(pages, metrics, pageWidth);
    }

    private renderPageLayer(pages: readonly PageRange[], metrics: PageMetrics, pageWidth: number): void {
        const signature = `${Math.round(pageWidth)}:${pages.map(page => Math.round(page.pageHeight)).join(',')}`;
        if (signature === this.pageLayerSignature) {return;}
        this.pageLayerSignature = signature;
        const layer = this.ensurePageLayer();
        const fragment = document.createDocumentFragment();
        let top = metrics.gap;
        pages.forEach((page, index) => {
            const paper = document.createElement('div');
            paper.className = 'snaptex-page-paper';
            paper.style.top = `${top}px`;
            paper.style.width = `${pageWidth}px`;
            paper.style.height = `${page.pageHeight}px`;
            paper.dataset.pageNumber = String(index + 1);
            if (page.extended) {paper.dataset.extended = 'true';}
            fragment.appendChild(paper);
            top += page.pageHeight + metrics.gap;
        });
        layer.replaceChildren(fragment);
    }

    private ensurePageLayer(): HTMLElement {
        if (this.pageLayer?.isConnected) {return this.pageLayer;}
        const host = this.contentRoot.parentElement ?? document.body;
        host.classList.add('snaptex-page-host');
        this.pageLayer = document.createElement('div');
        this.pageLayer.className = 'snaptex-page-layer';
        host.insertBefore(this.pageLayer, this.contentRoot);
        return this.pageLayer;
    }

    private clearLayout(): void {
        if (this.scheduledFrame !== undefined) {
            cancelAnimationFrame(this.scheduledFrame);
            this.scheduledFrame = undefined;
        }
        this.resizeObserver?.disconnect();
        this.observedItems.clear();
        this.getItems().forEach(item => {
            item.classList.remove('snaptex-page-start');
            item.style.removeProperty('--snaptex-page-before');
        });
        this.contentRoot.style.removeProperty('--snaptex-page-side-margin');
        this.contentRoot.style.removeProperty('--snaptex-page-tail');
        this.pageLayer?.remove();
        this.pageLayer = undefined;
        this.pageLayerSignature = '';
        this.contentRoot.parentElement?.classList.remove('snaptex-page-host');
    }
}
