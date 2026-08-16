import type { ViewportAnchorController } from './viewport';

const PAGE_ASPECT_RATIO = 297 / 210;
const PAGE_TOP_MARGIN_RATIO = 20 / 210;
const PAGE_BOTTOM_MARGIN_RATIO = 20 / 210;
const PAGE_MIN_BOTTOM_MARGIN_RATIO = 10 / 210;
const PAGE_MAX_BOTTOM_MARGIN_RATIO = 34 / 210;
const PAGE_SIDE_MARGIN_RATIO = 18 / 210;

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

/** Applies optional page-like layout without changing the rendered block DOM. */
export class PageLayoutController {
    private enabled = false;
    private forceMeasure = true;
    private scheduledFrame: number | undefined;
    private readonly heights = new WeakMap<Element, number>();
    private readonly resizeObserver?: ResizeObserver;
    private readonly observedItems = new Set<HTMLElement>();
    private markerLayer?: HTMLElement;

    constructor(
        private readonly contentRoot: HTMLElement,
        private readonly viewportAnchor: ViewportAnchorController
    ) {
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(entries => {
                let changed = false;
                entries.forEach(entry => {
                    const height = Math.ceil(entry.contentRect.height);
                    if (this.heights.get(entry.target) === height) {return;}
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

    isEnabled(): boolean {
        return this.enabled;
    }

    invalidateItem(item: Element | null): void {
        if (item) {this.heights.delete(item);}
        this.refresh();
    }

    reset(): void {
        this.forceMeasure = true;
        this.clearLayout();
        if (this.enabled) {this.schedule();}
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
            const height = cached ?? Math.ceil(Math.max(item.getBoundingClientRect().height, item.scrollHeight));
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
            maxBottomMargin: pageWidth * PAGE_MAX_BOTTOM_MARGIN_RATIO
        };
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
        this.viewportAnchor.preserve(items, () => this.applyLayout(items, pages, metrics, pageWidth));
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
                ? previousPage.pageHeight - previousPage.usedHeight
                : metrics.topMargin;
            const spacing = `${Math.round(Math.max(0, before))}px`;
            item.classList.add('snaptex-page-start');
            if (item.style.getPropertyValue('--snaptex-page-before') !== spacing) {
                item.style.setProperty('--snaptex-page-before', spacing);
            }
            previousPage = page;
        });

        const lastPage = pages[pages.length - 1];
        this.contentRoot.style.setProperty('--snaptex-page-tail', `${Math.round(lastPage.pageHeight - metrics.topMargin - lastPage.usedHeight)}px`);
        this.renderPageMarkers(items, pages, metrics, pageWidth);
    }

    private renderPageMarkers(items: readonly HTMLElement[], pages: readonly PageRange[], metrics: PageMetrics, pageWidth: number): void {
        const layer = this.ensureMarkerLayer();
        while (layer.children.length < pages.length) {
            const marker = document.createElement('div');
            marker.className = 'snaptex-page-marker';
            const number = document.createElement('span');
            number.className = 'snaptex-page-number';
            marker.appendChild(number);
            layer.appendChild(marker);
        }
        while (layer.children.length > pages.length) {layer.lastElementChild?.remove();}

        const host = layer.parentElement ?? document.body;
        const hostTop = host.getBoundingClientRect().top;
        host.style.setProperty('--snaptex-page-side-margin', `${Math.round(pageWidth * PAGE_SIDE_MARGIN_RATIO)}px`);
        pages.forEach((page, index) => {
            const marker = layer.children[index] as HTMLElement;
            marker.style.top = `${Math.round(items[page.start].getBoundingClientRect().top - hostTop - metrics.topMargin)}px`;
            marker.classList.toggle('snaptex-first-page-marker', index === 0);
            const number = marker.firstElementChild as HTMLElement;
            number.textContent = String(index + 1);
        });
        layer.style.height = `${Math.ceil(this.contentRoot.getBoundingClientRect().height)}px`;
    }

    private ensureMarkerLayer(): HTMLElement {
        if (this.markerLayer?.isConnected) {return this.markerLayer;}
        const host = this.contentRoot.parentElement ?? document.body;
        host.classList.add('snaptex-page-host');
        this.markerLayer = document.createElement('div');
        this.markerLayer.className = 'snaptex-page-marker-layer';
        host.insertBefore(this.markerLayer, this.contentRoot);
        return this.markerLayer;
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
        this.contentRoot.style.removeProperty('--snaptex-page-tail');
        this.markerLayer?.remove();
        this.markerLayer = undefined;
        const host = this.contentRoot.parentElement ?? document.body;
        host.style.removeProperty('--snaptex-page-side-margin');
        host.classList.remove('snaptex-page-host');
    }
}
