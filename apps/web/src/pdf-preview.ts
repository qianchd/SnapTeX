import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import type { EventBus } from 'pdfjs-dist/types/web/event_utils';
import type { PDFLinkService } from 'pdfjs-dist/types/web/pdf_link_service';
import type { PDFViewer } from 'pdfjs-dist/types/web/pdf_viewer';
import { ChevronLeft, ChevronRight, createElement, Download, Maximize2, Minus, Plus } from 'lucide';
import type { PdfPosition } from '../../standalone/src/browser-project';
import { debounce } from '../../../src/utils';

interface PdfViewLocation {
    pageNumber: number;
    left: number;
    top: number;
}

export class PdfPreview {
    private readonly scroll: HTMLDivElement;
    private readonly pages: HTMLDivElement;
    private readonly pageInput: HTMLInputElement;
    private readonly pageCount: HTMLSpanElement;
    private readonly download: HTMLAnchorElement;
    private viewer?: PDFViewer;
    private viewerPromise?: Promise<PDFViewer>;
    private pdfjs?: typeof import('pdfjs-dist');
    private documentTask?: PDFDocumentLoadingTask;
    private pendingTask?: PDFDocumentLoadingTask;
    private generation = 0;
    private location?: PdfViewLocation;
    private documentPath?: string;
    private restoreLocation?: PdfViewLocation;
    private pendingReveal?: { point: PdfPosition; viewRatio: number; highlight: boolean };
    private readonly ready: Promise<void>;
    private downloadUrl?: string;
    private highlight?: HTMLDivElement;
    private readonly syncScroll: ReturnType<typeof debounce<[]>>;

    constructor(host: HTMLElement, onSync: (point: PdfPosition, viewRatio: number, auto: boolean) => void,
        onInteraction: () => void, scrollDelay: () => number) {
        const shadow = host.attachShadow({ mode: 'open' });
        const stylesheet = document.createElement('link');
        stylesheet.rel = 'stylesheet';
        stylesheet.href = new URL('media/vendor/pdfjs/pdf_viewer.css', document.baseURI).toString();
        this.ready = new Promise((resolve, reject) => {
            stylesheet.onload = () => resolve();
            stylesheet.onerror = () => reject(new Error('PDF.js viewer stylesheet could not load.'));
        });
        const style = document.createElement('style');
        style.textContent = `
            :host{display:block;position:relative;height:100%;--page-margin:8px auto;--page-border:1px solid #aaa;--pdfViewer-padding-bottom:8px}
            #scroll{position:absolute;inset:0;overflow:auto;background:#777}
            #toolbar{position:absolute;z-index:10;top:5px;left:50%;display:flex;align-items:center;gap:2px;padding:2px;border:1px solid #555;border-radius:4px;background:#2b2b2b;color:#fff;box-shadow:0 2px 8px #0006;opacity:0;transform:translateX(-50%);transition:opacity 120ms ease}
            #toolbar:hover,#toolbar:focus-within{opacity:1}
            button,a{display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:3px;background:transparent;color:inherit;cursor:pointer}
            button:hover,a:hover{background:#ffffff20}
            button:disabled{opacity:.4;cursor:default}
            svg{width:15px;height:15px;stroke:currentColor}
            #page{width:3.2em;height:21px;box-sizing:border-box;border:1px solid #666;border-radius:3px;background:#1f1f1f;color:#fff;font-size:11px;text-align:center}
            #count{min-width:2.3em;color:#ddd;font:11px/1.2 system-ui,sans-serif;white-space:nowrap}
            .separator{width:1px;height:17px;margin:0 1px;background:#666}
            .sync-highlight{position:absolute;z-index:8;min-width:32px;min-height:10px;border-radius:2px;pointer-events:none;animation:sync-highlight 1.4s ease-out forwards}
            @keyframes sync-highlight{0%{background:transparent}20%{background:#ffeb3b73}100%{background:transparent}}
        `;
        this.scroll = document.createElement('div');
        this.scroll.id = 'scroll';
        this.pages = document.createElement('div');
        this.pages.className = 'pdfViewer';
        this.scroll.append(this.pages);
        const toolbar = document.createElement('div');
        toolbar.id = 'toolbar';
        const button = (label: string, icon: Parameters<typeof createElement>[0], action: () => void) => {
            const control = document.createElement('button');
            control.type = 'button';
            control.title = label;
            control.setAttribute('aria-label', label);
            control.append(createElement(icon, { 'aria-hidden': 'true' }));
            control.addEventListener('click', action);
            return control;
        };
        const previous = button('Previous page', ChevronLeft, () => {
            if (this.viewer) {this.viewer.currentPageNumber = Math.max(1, this.viewer.currentPageNumber - 1);}
        });
        const next = button('Next page', ChevronRight, () => {
            if (this.viewer) {this.viewer.currentPageNumber = Math.min(this.viewer.pagesCount, this.viewer.currentPageNumber + 1);}
        });
        this.pageInput = document.createElement('input');
        this.pageInput.id = 'page';
        this.pageInput.type = 'number';
        this.pageInput.min = '1';
        this.pageInput.title = 'Page number';
        this.pageInput.setAttribute('aria-label', 'Page number');
        this.pageInput.addEventListener('change', () => {
            if (!this.viewer) {return;}
            const page = Number(this.pageInput.value);
            if (Number.isInteger(page) && page >= 1 && page <= this.viewer.pagesCount) {
                this.viewer.currentPageNumber = page;
            } else {
                this.pageInput.value = String(this.viewer.currentPageNumber);
            }
        });
        this.pageCount = document.createElement('span');
        this.pageCount.id = 'count';
        const zoomOut = button('Zoom out', Minus, () => this.zoom(1 / 1.1));
        const zoomIn = button('Zoom in', Plus, () => this.zoom(1.1));
        const fitWidth = button('Fit to width', Maximize2, () => {
            if (this.viewer) {this.viewer.currentScaleValue = 'page-width';}
        });
        this.download = document.createElement('a');
        this.download.title = 'Download';
        this.download.setAttribute('aria-label', 'Download');
        this.download.append(createElement(Download, { 'aria-hidden': 'true' }));
        this.download.addEventListener('click', event => {
            if (!this.downloadUrl) {event.preventDefault();}
        });
        toolbar.append(
            previous,
            next,
            this.pageInput,
            this.pageCount,
            this.separator(),
            zoomOut,
            zoomIn,
            fitWidth,
            this.separator(),
            this.download
        );
        shadow.append(stylesheet, style, this.scroll, toolbar);
        toolbar.addEventListener('pointerdown', onInteraction, { passive: true });
        const syncAt = (clientX: number, clientY: number, auto: boolean) => {
            if (host.clientHeight <= 0 || host.clientWidth <= 0) {return;}
            const page = shadow.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('.page[data-page-number]');
            if (!page || !this.viewer) {return;}
            const pageNumber = Number(page.dataset.pageNumber);
            const pageView = this.viewer.getPageView(pageNumber - 1);
            const viewport = pageView?.viewport;
            const rect = page.querySelector('.canvasWrapper')?.getBoundingClientRect() ?? page.getBoundingClientRect();
            if (!viewport || rect.width <= 0 || rect.height <= 0) {return;}
            const [pdfX, pdfY] = viewport.convertToPdfPoint(
                (clientX - rect.left) * viewport.width / rect.width,
                (clientY - rect.top) * viewport.height / rect.height
            );
            const scrollRect = this.scroll.getBoundingClientRect();
            onSync({ page: pageNumber, x: pdfX - viewport.viewBox[0], y: viewport.viewBox[3] - pdfY },
                (clientY - scrollRect.top) / scrollRect.height, auto);
        };
        this.scroll.addEventListener('dblclick', event => {
            onInteraction();
            syncAt(event.clientX, event.clientY, false);
        });
        for (const event of ['wheel', 'pointerdown', 'touchstart']) {
            this.scroll.addEventListener(event, onInteraction, { passive: true });
        }
        this.syncScroll = debounce(() => {
            const rect = this.scroll.getBoundingClientRect();
            syncAt(rect.left + rect.width / 2, rect.top + rect.height / 2, true);
        }, scrollDelay);
        this.scroll.addEventListener('scroll', this.syncScroll, { passive: true });
        new ResizeObserver(() => {
            if (host.clientWidth > 0 && host.clientHeight > 0 && this.viewer?.pagesCount) {
                this.viewer.currentScaleValue = 'page-width';
            }
        }).observe(host);
    }

    private async createViewer(): Promise<PDFViewer> {
        await this.ready;
        const pdfjs = await import(new URL('media/vendor/pdfjs/pdf.mjs', document.baseURI).toString()) as typeof import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('media/vendor/pdfjs/pdf.worker.mjs', document.baseURI).toString();
        this.pdfjs = pdfjs;
        const viewerModule = await import(new URL('media/vendor/pdfjs/pdf_viewer.mjs', document.baseURI).toString()) as {
            EventBus: new () => EventBus;
            PDFLinkService: new (options: { eventBus: EventBus }) => PDFLinkService;
            PDFViewer: new (options: {
                container: HTMLDivElement;
                viewer: HTMLDivElement;
                eventBus: EventBus;
                linkService: PDFLinkService;
                removePageBorders: boolean;
            }) => PDFViewer;
        };
        const eventBus = new viewerModule.EventBus();
        const linkService = new viewerModule.PDFLinkService({ eventBus });
        const viewer = new viewerModule.PDFViewer({
            container: this.scroll,
            viewer: this.pages,
            eventBus,
            linkService,
            removePageBorders: true
        });
        linkService.setViewer(viewer);
        eventBus.on('updateviewarea', (event: { location?: PdfViewLocation }) => {
            if (event.location) {this.location = event.location;}
        });
        eventBus.on('pagechanging', (event: { pageNumber: number }) => {
            this.pageInput.value = String(event.pageNumber);
        });
        eventBus.on('pagesinit', () => {
            this.pageInput.value = String(viewer.currentPageNumber);
            this.pageInput.max = String(viewer.pagesCount);
            this.pageCount.textContent = `/ ${viewer.pagesCount}`;
            viewer.currentScaleValue = 'page-width';
            if (this.pendingReveal) {
                void this.applyPendingReveal();
            } else if (this.restoreLocation) {
                const location = this.restoreLocation;
                viewer.scrollPageIntoView({
                    pageNumber: Math.min(location.pageNumber, viewer.pagesCount),
                    destArray: [null, { name: 'XYZ' }, location.left, location.top, null],
                    allowNegativeOffset: true,
                    ignoreDestinationZoom: true
                });
            }
            this.restoreLocation = undefined;
        });
        this.viewer = viewer;
        return viewer;
    }

    async open(blob: Blob, path: string): Promise<void> {
        const generation = ++this.generation;
        if (this.pendingTask) {void this.pendingTask.destroy(); this.pendingTask = undefined;}
        const viewer = await (this.viewerPromise ??= this.createViewer());
        if (generation !== this.generation) {return;}
        const data = new Uint8Array(await blob.arrayBuffer());
        if (generation !== this.generation) {return;}
        const pdfjs = this.pdfjs!;
        const task = pdfjs.getDocument({ data });
        this.pendingTask = task;
        try {
            const pdf = await task.promise;
            if (generation !== this.generation) {
                await task.destroy();
                return;
            }
            if (this.downloadUrl) {URL.revokeObjectURL(this.downloadUrl);}
            this.downloadUrl = URL.createObjectURL(blob);
            this.download.href = this.downloadUrl;
            this.download.download = path.split('/').pop() || 'document.pdf';
            this.restoreLocation = this.documentPath === path ? this.location : undefined;
            this.documentPath = path;
            const previous = this.documentTask;
            this.documentTask = task;
            this.pendingTask = undefined;
            viewer.setDocument(pdf);
            (viewer.linkService as PDFLinkService).setDocument(pdf);
            if (previous) {void previous.destroy();}
        } catch (error) {
            await task.destroy();
            if (generation === this.generation) {throw error;}
        } finally {
            if (this.pendingTask === task) {this.pendingTask = undefined;}
        }
    }

    get currentPage(): number {return this.viewer?.currentPageNumber ?? 0;}

    reveal(point: PdfPosition, viewRatio = 0.5, highlight = true): void {
        this.pendingReveal = { point, viewRatio, highlight };
        void this.applyPendingReveal();
    }

    private separator(): HTMLSpanElement {
        const separator = document.createElement('span');
        separator.className = 'separator';
        return separator;
    }

    private zoom(factor: number): void {
        if (this.viewer?.pagesCount) {this.viewer.currentScaleValue = String(this.viewer.currentScale * factor);}
    }

    private async applyPendingReveal(): Promise<void> {
        const request = this.pendingReveal;
        const viewer = this.viewer;
        if (!request || !viewer || this.pendingTask || !viewer.pdfDocument) {return;}
        const { point, viewRatio, highlight: showHighlight } = request;
        if (point.page < 1 || point.page > viewer.pagesCount) {return;}
        const generation = this.generation;
        const page = viewer.getPageView(point.page - 1);
        if (!page.pdfPage) {
            const pdfPage = await viewer.pdfDocument.getPage(point.page);
            if (generation !== this.generation || this.pendingReveal !== request) {return;}
            if (!page.pdfPage) {page.setPdfPage(pdfPage);}
        }
        const viewport = page.viewport;
        viewer.scrollPageIntoView({
            pageNumber: point.page,
            destArray: [null, { name: 'XYZ' }, viewport.viewBox[0] + point.x, viewport.viewBox[3] - point.y, null],
            ignoreDestinationZoom: true,
            allowNegativeOffset: true
        });
        const [, targetY] = viewport.convertToViewportPoint(viewport.viewBox[0] + point.x, viewport.viewBox[3] - point.y);
        const pageTop = page.div.offsetTop;
        this.scroll.scrollTop = pageTop + targetY - this.scroll.clientHeight * viewRatio;
        this.pendingReveal = undefined;
        if (!showHighlight) {return;}
        const boxX = point.boxX ?? point.x;
        const top = (point.baseline ?? point.y) - (point.height ?? 5);
        const bottom = (point.baseline ?? point.y) + (point.depth ?? 5);
        const [x1, y1] = viewport.convertToViewportPoint(viewport.viewBox[0] + boxX, viewport.viewBox[3] - top);
        const [x2, y2] = viewport.convertToViewportPoint(
            viewport.viewBox[0] + boxX + (point.width ?? 0),
            viewport.viewBox[3] - bottom
        );
        this.highlight?.remove();
        const highlight = document.createElement('div');
        highlight.className = 'sync-highlight';
        highlight.style.left = `${Math.min(x1, x2)}px`;
        highlight.style.top = `${Math.min(y1, y2)}px`;
        if (point.width) {highlight.style.width = `${Math.abs(x2 - x1)}px`;}
        if (point.height || point.depth) {highlight.style.height = `${Math.abs(y2 - y1)}px`;}
        page.div.append(highlight);
        this.highlight = highlight;
        highlight.addEventListener('animationend', () => {
            highlight.remove();
            if (this.highlight === highlight) {this.highlight = undefined;}
        }, { once: true });
    }

    close(): void {
        this.generation++;
        this.syncScroll.cancel();
        this.location = undefined;
        this.documentPath = undefined;
        this.restoreLocation = undefined;
        this.pendingReveal = undefined;
        this.highlight?.remove();
        this.highlight = undefined;
        this.viewer?.setDocument(null as never);
        if (this.viewer) {(this.viewer.linkService as PDFLinkService).setDocument(null);}
        const task = this.documentTask;
        this.documentTask = undefined;
        if (task) {void task.destroy();}
        if (this.pendingTask) {void this.pendingTask.destroy(); this.pendingTask = undefined;}
        if (this.downloadUrl) {
            URL.revokeObjectURL(this.downloadUrl);
            this.downloadUrl = undefined;
        }
    }
}
