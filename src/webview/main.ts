// @ts-nocheck
/* eslint-disable curly */
import { CoalescingTaskScheduler } from './scheduler';
import { BLOCK_VIRTUALIZATION_CLEANUP_DELAY_MS, BlockVirtualizationController, isElementWithinViewportMargins, parseFirstElementFromHtml, viewportHeightToPixels } from './virtualization';
import { hasRenderedTikz, setTikzContainerState, TIKZ_BATCH_RENDER_TIMEOUT_MS, TIKZ_RENDER_DEBOUNCE_MS, TIKZ_SCRIPT_SELECTOR } from './tikz';
import { HostToPreviewCommand, PreviewToHostCommand } from '../preview-messages';
import { getPreviewBridge } from './bridge';
const previewBridge = getPreviewBridge();
    const PREVIEW_LAYOUT_WIDTH_CHANGE_EPSILON_PX = 12;
    const PDF_RENDER_MARGIN_VH = 130;
    const PDF_RELEASE_MARGIN_VH = 380;
    window.pdfReqQueue = [];
    window.renderPdfToCanvas = function(path, canvasId) {
        window.pdfReqQueue.push({ path, canvasId });
    };

    /**
     * Coordinates transient and pinned reference tooltips.
     */
    class TooltipManager {
        constructor() {
            this.activeTransientTooltip = null;
            this.zIndexCounter = 1000;
            this.bindGlobalEvents();
        }

        bindGlobalEvents() {
            document.body.addEventListener('mouseover', (e) => {
                const link = e.target.closest('a');
                if (link && link.getAttribute('href')?.startsWith('#')) {
                    const parentTooltip = link.closest('.hover-tooltip');
                    if (parentTooltip && !parentTooltip.classList.contains('pinned')) {
                        return;
                    }
                    this.onLinkEnter(link, e.clientY);
                }
            });

            document.body.addEventListener('mouseout', (e) => {
                const link = e.target.closest('a');
                if (link && link.getAttribute('href')?.startsWith('#')) {
                    if (this.activeTransientTooltip &&
                        this.activeTransientTooltip.element.contains(e.relatedTarget)) {
                        return;
                    }
                    this.onLinkLeave();
                }
            });

        }

        onLinkEnter(link, anchorY) {
            if (!this.activeTransientTooltip || this.activeTransientTooltip.isPinned) {
                this.activeTransientTooltip = new Tooltip(this);
            }

            this.activeTransientTooltip.scheduleShow(link, anchorY);
        }

        onLinkLeave() {
            if (this.activeTransientTooltip) {
                this.activeTransientTooltip.onLinkLeave();
            }
        }

        getTopZIndex() {
            return ++this.zIndexCounter;
        }

    }

    /**
     * Floating preview for references, citations, and local anchors.
     */
    class Tooltip {
        constructor(manager) {
            this.manager = manager;
            this.element = this.createDOM();
            document.body.appendChild(this.element);

            this.header = this.element.querySelector('.tooltip-header');
            this.contentContainer = this.element.querySelector('.tooltip-content');
            this.pinBtn = this.element.querySelector('.pin-btn');
            this.closeBtn = this.element.querySelector('.close-btn');

            this.resizeRight = this.element.querySelector('.resize-handle-right');
            this.resizeBottom = this.element.querySelector('.resize-handle-bottom');
            this.resizeCorner = this.element.querySelector('.resize-handle-corner');

            this.isPinned = false;
            this.currentLink = null;
            this.anchorY = null;
            this.hideTimer = null;
            this.showTimer = null;

            this.isDragging = false;
            this.resizeState = null;

            this.bindEvents();
            this.bringToFront();
        }

        createDOM() {
            const el = document.createElement('div');
            el.className = 'hover-tooltip';
            el.innerHTML = `
                <div class="tooltip-header">
                    <span class="drag-handle-icon">::::</span>
                    <div class="header-controls">
                        <button class="icon-btn pin-btn" title="Pin / Unpin">📌</button>
                        <button class="icon-btn close-btn" title="Close">✕</button>
                    </div>
                </div>
                <div class="tooltip-content"></div>
                <div class="resize-handle-right"></div>
                <div class="resize-handle-bottom"></div>
                <div class="resize-handle-corner"></div>
            `;
            return el;
        }

        bindEvents() {
            this.element.addEventListener('mouseenter', () => this.clearHideTimer());
            this.element.addEventListener('mouseleave', () => this.startHideTimer());

            this.element.addEventListener('mousedown', () => this.bringToFront());

            this.pinBtn.addEventListener('click', (e) => { e.stopPropagation(); this.togglePin(); });
            this.closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.dispose(); });

            this.header.addEventListener('mousedown', (e) => this.startDrag(e));

            this.resizeBottom.addEventListener('mousedown', (e) => this.startResize(e, false, true));
            this.resizeRight.addEventListener('mousedown', (e) => this.startResize(e, true, false));
            this.resizeCorner.addEventListener('mousedown', (e) => this.startResize(e, true, true));

            this._onWindowMouseMove = (e) => this.onMouseMove(e);
            this._onWindowMouseUp = (e) => this.onMouseUp(e);
            window.addEventListener('mousemove', this._onWindowMouseMove);
            window.addEventListener('mouseup', this._onWindowMouseUp);
        }

        bringToFront() {
            this.element.style.zIndex = this.manager.getTopZIndex();
        }

        togglePin() {
            this.isPinned = !this.isPinned;
            if (this.isPinned) {
                this.pinBtn.classList.add('active');
                this.element.classList.add('pinned');
                this.clearHideTimer();
                if (this.manager.activeTransientTooltip === this) {
                    this.manager.activeTransientTooltip = null;
                }
            } else {
                this.pinBtn.classList.remove('active');
                this.element.classList.remove('pinned');
                if (!this.element.matches(':hover')) {
                    this.startHideTimer();
                }
            }
        }

        dispose() {
            if (this.element && this.element.parentNode) {
                this.element.parentNode.removeChild(this.element);
            }
            window.removeEventListener('mousemove', this._onWindowMouseMove);
            window.removeEventListener('mouseup', this._onWindowMouseUp);

            if (this.manager.activeTransientTooltip === this) {
                this.manager.activeTransientTooltip = null;
            }
        }

        startDrag(e) {
            this.isDragging = true;

            this.ensureAbsolutePosition();

            const rect = this.element.getBoundingClientRect();

            this.element.style.cursor = 'grabbing';
            this.dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };

            e.preventDefault();
        }

        startResize(e, dirX, dirY) {
            this.ensureAbsolutePosition();

            const rect = this.element.getBoundingClientRect();

            this.resizeState = {
                startX: e.clientX,
                startY: e.clientY,
                startWidth: rect.width,
                startHeight: rect.height,
                dirX, dirY
            };

            this.element.style.maxHeight = 'none';
            this.element.style.maxWidth = 'none';

            e.preventDefault();
            e.stopPropagation();
        }

        ensureAbsolutePosition() {
            const rect = this.element.getBoundingClientRect();

            this.element.style.transform = 'none';

            this.element.style.left = `${rect.left}px`;
            this.element.style.top = `${rect.top}px`;
            this.element.style.bottom = '';

            this.element.style.width = `${rect.width}px`;
            this.element.style.height = `${rect.height}px`;
        }

        onMouseMove(e) {
            if (this.isDragging) {
                const x = e.clientX - this.dragOffset.x;
                const y = e.clientY - this.dragOffset.y;
                this.element.style.left = `${x}px`;
                this.element.style.top = `${y}px`;
                this.element.style.transform = 'none';
            } else if (this.resizeState) {
                const { startX, startY, startWidth, startHeight, dirX, dirY } = this.resizeState;
                if (dirX) {
                    this.element.style.width = `${Math.max(300, startWidth + (e.clientX - startX))}px`;
                }
                if (dirY) {
                    this.element.style.height = `${Math.max(100, startHeight + (e.clientY - startY))}px`;
                }
            }
        }

        onMouseUp() {
            this.isDragging = false;
            this.resizeState = null;
            this.element.style.cursor = '';
        }

        scheduleShow(link, anchorY) {
            this.clearHideTimer();
            if (this.currentLink === link && this.element.classList.contains('visible')) return;

            if (this.showTimer) clearTimeout(this.showTimer);
            this.anchorY = anchorY ?? null;

            this.showTimer = setTimeout(() => {
                this.onLinkEnter(link);
            }, 200);
        }

        cancelShow() {
            if (this.showTimer) {
                clearTimeout(this.showTimer);
                this.showTimer = null;
            }
        }

        onLinkEnter(link) {
            this.currentLink = link;
            const targetId = link.getAttribute('href').substring(1);
            this.showPreview(link, targetId);
        }

        onLinkLeave() {
            this.cancelShow();
            this.startHideTimer();
        }

        startHideTimer() {
            if (this.isPinned) return;

            if (this.hideTimer) clearTimeout(this.hideTimer);
            this.hideTimer = setTimeout(() => {
                this.hide();
            }, 300);
        }

        clearHideTimer() {
            if (this.hideTimer) {
                clearTimeout(this.hideTimer);
                this.hideTimer = null;
            }
        }

        hide() {
            this.element.classList.remove('visible');
            setTimeout(() => {
                if (!this.element.classList.contains('visible')) {
                    this.dispose();
                }
            }, 200);
        }

        async showPreview(linkElement, targetId) {
            const targetEl = await this.resolveTargetElement(targetId);
            if (this.currentLink !== linkElement) return;
            if (!targetEl) return;

            const container = targetEl.closest('.latex-block') || targetEl.closest('.bib-item');
            if (!container) return;

            this.contentContainer.innerHTML = '';
            const frag = document.createDocumentFragment();

            if (container.classList.contains('latex-block')) {
                const blocks = await this.resolveContextBlocks(container);
                if (this.currentLink !== linkElement) return;
                const targetIndex = container.getAttribute('data-index');
                blocks.forEach(block => this.appendBlockClone(frag, block, block.getAttribute('data-index') === targetIndex));
            } else {
                const clone = container.cloneNode(true);
                this.cleanNode(clone);
                frag.appendChild(clone);
            }

            this.contentContainer.appendChild(frag);
            this.refreshPDFs();
            this.positionTooltip(linkElement, this.anchorY);

            setTimeout(() => {
                 this.triggerTikzRendering();
            }, 10);

            requestAnimationFrame(() => {
                this.element.classList.add('visible');
            });
        }

        async resolveContextBlocks(container) {
            const controller = window.snaptexPreviewController;
            if (controller && typeof controller.getTooltipContextBlocks === 'function') {
                return controller.getTooltipContextBlocks(container);
            }
            return [container.previousElementSibling, container, container.nextElementSibling]
                .filter(block => block && block.classList.contains('latex-block'));
        }

        appendBlockClone(fragment, block, isTarget) {
            const clone = block.cloneNode(true);
            clone.classList.add(isTarget ? 'target-block' : 'context-block');
            this.cleanNode(clone);
            fragment.appendChild(clone);
        }

        async resolveTargetElement(targetId) {
            const existing = document.getElementById(targetId);
            if (existing) return existing;

            const controller = window.snaptexPreviewController;
            if (controller && typeof controller.ensureAnchorMounted === 'function') {
                return controller.ensureAnchorMounted(targetId);
            }
            return null;
        }

        triggerTikzRendering() {
            if (this.contentContainer.querySelector(TIKZ_SCRIPT_SELECTOR)) {
                 window.watchPendingTikzContainers(this.contentContainer);
                 window.activatePendingTikzScripts(this.contentContainer);
                 window.ensureTikzJaxLoaded().catch(error => {
                     window.failPendingTikzContainers('TikZ rendering failed.');
                     console.warn('[SnapTeX] Failed to load TikZJax for tooltip content.', error);
                 });
            }
        }

        cleanNode(node) {
            if (node.id) node.removeAttribute('id');
            node.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
        }

        refreshPDFs() {
            const canvases = this.contentContainer.querySelectorAll('canvas[data-req-path]');
            canvases.forEach(canvas => {
                const newId = 'tooltip-pdf-' + Math.random().toString(36).substr(2, 9);
                canvas.id = newId;
                canvas.removeAttribute('data-rendered');
                canvas.removeAttribute('data-requested');
                const path = canvas.getAttribute('data-req-path');
                if (path) { window.renderPdfToCanvas(path, newId); }
            });
        }

        getTooltipBounds() {
            const host = document.getElementById('preview-pane') || document.getElementById('content-root');
            const rect = host?.getBoundingClientRect();
            if (rect && rect.width > 0) {
                return rect;
            }
            return { left: 0, right: window.innerWidth, width: window.innerWidth };
        }

        positionTooltip(linkElement, anchorY) {
            const linkRect = linkElement.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            const margin = 15;
            const bounds = this.getTooltipBounds();
            const maxWidth = Math.max(300, bounds.width - margin * 2);
            const verticalAnchor = anchorY ?? linkRect.top + linkRect.height / 2;

            this.element.style.maxWidth = `${maxWidth}px`;
            this.element.style.left = `${bounds.left + margin}px`;
            this.element.style.right = 'auto';

            if (verticalAnchor < viewportHeight / 2) {
                this.element.style.top = `${verticalAnchor + margin}px`;
                this.element.style.bottom = '';
            } else {
                this.element.style.bottom = `${viewportHeight - verticalAnchor + margin}px`;
                this.element.style.top = 'auto';
            }
        }
    }

    /**
     * Applies extension update messages to the preview DOM and coordinates
     * scroll sync, block virtualization, PDF rendering, tooltips, and TikZ.
     */
    class PreviewController {
        constructor() {
            this.contentRoot = document.getElementById('content-root');
            this.state = 'SCROLLING_AUTO';
            this.scrollTimeout = null;
            this.pendingScroll = null;
            this.isFirstLoad = true;
            this.lastScrollTime = 0;
            this.scrollCommandSeq = 0;
            this.previewLayoutSyncSuppressedUntil = 0;
            this.lastPreviewWidth = this.getPreviewWidth();
            this.virtualUpdateFrame = null;
            this.virtualCleanupTimer = null;
            this.config = {
                autoScrollDelay: 100,
                debugMemory: false,
                virtualMode: true
            };
            this.currentNumbering = null;
            this.blockHtmlRequestSeq = 0;
            this.pendingBlockHtmlRequests = new Map();
            this.pdfObserver = null;
            this.pdfRenderTimer = null;
            this.deferHeavyPreviewWork = false;
            this.initialExpansionFrame = null;
            this.virtualization = new BlockVirtualizationController(this.contentRoot);
            this.debugStats = {
                blockHtmlRequestsSent: 0,
                blockHtmlResponses: 0,
                blockHtmlChars: 0,
                maxBlockHtmlChars: 0,
                blockMounts: 0,
                tikzBatchRuns: 0,
                tikzActivatedScripts: 0,
                pdfRenderRuns: 0
            };
            window.snaptexPreviewController = this;
            this.tikzRenderScheduler = new CoalescingTaskScheduler({
                debounceMs: TIKZ_RENDER_DEBOUNCE_MS,
                run: () => this.runTikzRenderBatch(),
                onError: error => {
                    window.failPendingTikzContainers('TikZ rendering failed.');
                    console.warn('[SnapTeX] Failed to render TikZ preview content.', error);
                }
            });

            new TooltipManager();

            this.initPdfObserver();
            this.bindEvents();
            previewBridge.postMessage({ command: PreviewToHostCommand.PreviewLoaded });
        }

        bindEvents() {
            window.addEventListener('message', event => this.onMessage(event));
            window.addEventListener('scroll', () => {
                this.requestVirtualizedUpdate({ allowUnmount: false });
                this.scheduleVirtualizedCleanup();
                this.onScroll();
            });
            window.addEventListener('resize', () => this.onPreviewResize());
            if (typeof ResizeObserver !== 'undefined' && this.contentRoot) {
                this.previewResizeObserver = new ResizeObserver(entries => {
                    const width = entries[0]?.contentRect?.width;
                    this.onPreviewResize(width);
                });
                this.previewResizeObserver.observe(this.contentRoot);
            }
            document.addEventListener('dblclick', event => this.onDoubleClick(event));
            document.addEventListener('click', event => this.onInternalLinkClick(event));
        }

        getSyncSuppressionDuration() {
            return Math.max(500, this.config.autoScrollDelay + 300);
        }

        getPreviewWidth() {
            const rect = this.contentRoot?.getBoundingClientRect();
            return rect && rect.width > 0 ? rect.width : window.innerWidth;
        }

        onPreviewResize(width = this.getPreviewWidth()) {
            this.updateVirtualizedBlocks({ allowUnmount: true });
            if (!Number.isFinite(width) || width <= 0 || Math.abs(width - this.lastPreviewWidth) < PREVIEW_LAYOUT_WIDTH_CHANGE_EPSILON_PX) {
                return;
            }
            this.lastPreviewWidth = width;
            this.previewLayoutSyncSuppressedUntil = Date.now() + this.getSyncSuppressionDuration();
            previewBridge.postMessage({ command: PreviewToHostCommand.PreviewLayoutChanged });
        }

        lockScrolling(duration) {
            this.state = 'SCROLLING_AUTO';
            if (this.scrollTimeout) clearTimeout(this.scrollTimeout);
            this.scrollTimeout = setTimeout(() => {
                if (this.state === 'SCROLLING_AUTO') { this.state = 'IDLE'; }
            }, duration);
        }

        onMessage(event) {
            const { command, payload } = event.data;
            switch (command) {
                case HostToPreviewCommand.Update:
                    this.handleUpdate(payload);
                    break;

                case HostToPreviewCommand.ScrollToBlock:
                    this.handleScrollCommand(event.data);
                    break;

                case HostToPreviewCommand.BlockHtml:
                    this.handleBlockHtml(event.data);
                    break;

                case HostToPreviewCommand.Config:
                    if (event.data.config && typeof event.data.config.autoScrollDelay === 'number') {
                        this.config.autoScrollDelay = Math.max(0, event.data.config.autoScrollDelay);
                    }
                    if (event.data.config && typeof event.data.config.debugMemory === 'boolean') {
                        this.config.debugMemory = event.data.config.debugMemory;
                    }
                    this.config.virtualMode = event.data.config.virtualMode !== false;
                    this.virtualization.setEnabled(event.data.config.virtualMode !== false);
                    this.updateVirtualizedBlocks({ allowUnmount: true });
                    break;
            }
        }

        handleUpdate(payload) {
            this.logPayloadStats(payload);
            if (payload.resetPreviewState) {
                this.resetPreviewRuntimeState();
            }
            if (payload.numbering) {
                this.currentNumbering = payload.numbering;
            }
            if (payload.type === 'full') {
                this.state = 'RENDERING';
                this.deferHeavyPreviewWork = this.isFirstLoad && !!payload.blocks && this.virtualization.isEnabled();
                const scrollState = this.saveScrollState();
                document.body.classList.add('preload-mode');
                if (payload.blocks && this.virtualization.isEnabled()) {
                    this.smartFullUpdateFromBlockMetadata(payload.blocks, {
                        phase: this.deferHeavyPreviewWork ? 'initial' : 'normal'
                    });
                } else if (payload.htmls) {
                    this.smartFullUpdateFromBlocks(payload.htmls, payload.preserveUnchangedBlocks !== false);
                }
                this.logDomStats('after full update');
                document.fonts.ready.then(() => {
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => { this.onRenderComplete(scrollState); });
                    });
                });
            } else if (payload.type === 'patch') {
                this.applyPatch(payload);
                this.logDomStats('after patch update');
            }
            if (payload.numbering) {
                requestAnimationFrame(() => this.applyNumbering(payload.numbering));
            }
            if (!this.deferHeavyPreviewWork) {
                this.scheduleHeavyPreviewWork();
            }
        }

        resetPreviewRuntimeState() {
            this.pendingBlockHtmlRequests.clear();
            this.virtualization.resetCaches();
            this.isFirstLoad = true;
            this.deferHeavyPreviewWork = false;
            this.pendingScroll = null;
        }

        formatDebugMb(bytes) {
            return Math.round(bytes / 1024 / 1024 * 10) / 10;
        }

        sumStringChars(values) {
            return values.reduce((sum, value) => sum + (typeof value === 'string' ? value.length : 0), 0);
        }

        getPayloadStats(payload) {
            const htmls = Array.isArray(payload.htmls) ? payload.htmls : [];
            const dirtyBlocks = payload.dirtyBlocks ? Object.values(payload.dirtyBlocks) : [];
            return {
                type: payload.type,
                payloadKind: payload.blocks ? `${payload.type}:blocks` : `${payload.type}:htmls`,
                blocks: payload.blocks ? payload.blocks.length : 0,
                htmls: htmls.length,
                htmlChars: this.sumStringChars(htmls),
                dirtyBlocks: dirtyBlocks.length,
                dirtyBlockChars: this.sumStringChars(dirtyBlocks),
                numberingBlocks: payload.numbering?.blocks ? Object.keys(payload.numbering.blocks).length : 0,
                labels: payload.numbering?.labels ? Object.keys(payload.numbering.labels).length : 0
            };
        }

        logPayloadStats(payload) {
            if (!this.config.debugMemory || !payload) return;
            console.log('[SnapTeX][webview-payload]', this.getPayloadStats(payload));
        }

        getCanvasStats() {
            const canvases = Array.from(document.querySelectorAll('canvas'));
            let pixels = 0;
            canvases.forEach(canvas => {
                pixels += (canvas.width || 0) * (canvas.height || 0);
            });
            return {
                canvasCount: canvases.length,
                canvasPixels: pixels,
                canvasApproxMB: this.formatDebugMb(pixels * 4)
            };
        }

        getBrowserHeapStats() {
            const memory = performance && performance.memory;
            if (!memory) return {};
            return {
                jsHeapUsedMB: this.formatDebugMb(memory.usedJSHeapSize || 0),
                jsHeapTotalMB: this.formatDebugMb(memory.totalJSHeapSize || 0),
                jsHeapLimitMB: this.formatDebugMb(memory.jsHeapSizeLimit || 0)
            };
        }

        logDomStats(label) {
            if (!this.config.debugMemory) return;
            const canvasStats = this.getCanvasStats();
            console.log('[SnapTeX][webview]', label, {
                virtualMode: this.virtualization.isEnabled(),
                blocks: document.querySelectorAll('.latex-block').length,
                shells: document.querySelectorAll('.latex-block-shell').length,
                mountedShells: document.querySelectorAll('.latex-block-shell[data-mounted="true"]').length,
                contentChildren: this.contentRoot.children.length,
                ...this.virtualization.getCacheStats(),
                pendingBlockHtmlRequests: this.pendingBlockHtmlRequests.size,
                katexNodes: document.querySelectorAll('.katex').length,
                mathmlNodes: document.querySelectorAll('math').length,
                latexTables: document.querySelectorAll('.latex-table').length,
                tikzContainers: document.querySelectorAll('.tikz-container').length,
                pdfCanvases: document.querySelectorAll('canvas[data-req-path]').length,
                renderedPdfs: document.querySelectorAll('canvas[data-rendered="true"]').length,
                tikzScripts: document.querySelectorAll('script[type="text/tikz"], script[type="text/snaptex-tikz"]').length,
                svgCount: document.querySelectorAll('svg').length,
                ...canvasStats,
                scrollHeight: document.documentElement.scrollHeight,
                debugStats: { ...this.debugStats },
                ...this.getBrowserHeapStats()
            });
        }

        collectTikzPreviews(block) {
            if (!block) return [];
            return Array.from(block.querySelectorAll('.tikz-container')).map(container => {
                const rendered = container.querySelector('svg[role="img"]:not(.tikz-stale-preview), svg:not(.tikz-stale-preview)');
                return rendered ? rendered.cloneNode(true) : null;
            });
        }

        stashStaleTikzPreviewsOnShell(shell, previews) {
            if (!shell || !previews || !previews.some(Boolean)) return;
            shell._snaptexStaleTikzPreviews = previews;
        }

        consumeStaleTikzPreviewsFromShell(shell) {
            if (!shell || !shell._snaptexStaleTikzPreviews) return null;
            const previews = shell._snaptexStaleTikzPreviews;
            delete shell._snaptexStaleTikzPreviews;
            return previews;
        }

        attachStaleTikzPreviews(block, previews) {
            if (!block || !previews || previews.length === 0) return;
            const containers = Array.from(block.querySelectorAll('.tikz-container'));
            containers.forEach((container, index) => {
                if (hasRenderedTikz(container) || container.querySelector('.tikz-stale-preview')) return;

                const preview = previews[index];
                if (!preview) return;

                preview.classList.add('tikz-stale-preview');
                container.appendChild(preview);
                setTikzContainerState(container, 'stale');
            });
        }

        replaceBlockPreservingTikz(oldBlock, newBlock) {
            this.virtualization.rememberBlockHeight(oldBlock);
            oldBlock.replaceWith(newBlock);
            this.attachStaleTikzPreviews(newBlock, this.collectTikzPreviews(oldBlock));
        }

        rememberStaleTikzPreviews(element, staleTikzByIndex) {
            if (!element) return;
            const index = element.getAttribute('data-index');
            const previews = this.collectTikzPreviews(element);
            this.virtualization.rememberBlockHeight(element);
            if (index !== null && previews.some(Boolean)) {
                staleTikzByIndex.set(index, previews);
            }
        }

        onVirtualBlockMounted(block) {
            if (!block) return;
            this.debugStats.blockMounts += 1;

            const shell = block.closest('.latex-block-shell');
            this.attachStaleTikzPreviews(block, this.consumeStaleTikzPreviewsFromShell(shell));

            if (this.currentNumbering) {
                requestAnimationFrame(() => this.applyNumbering(this.currentNumbering));
            }
            if (!this.deferHeavyPreviewWork) {
                this.scheduleHeavyPreviewWork();
            }
        }

        requestVirtualizedUpdate(options = {}) {
            if (!this.virtualization.isEnabled() || this.virtualUpdateFrame) return;

            this.virtualUpdateFrame = requestAnimationFrame(() => {
                this.virtualUpdateFrame = null;
                this.updateVirtualizedBlocks(options);
            });
        }

        scheduleVirtualizedCleanup() {
            if (this.virtualCleanupTimer) {
                clearTimeout(this.virtualCleanupTimer);
            }
            this.virtualCleanupTimer = setTimeout(() => {
                this.virtualCleanupTimer = null;
                this.updateVirtualizedBlocks({ allowUnmount: true, pruneHtmlCache: true });
            }, BLOCK_VIRTUALIZATION_CLEANUP_DELAY_MS);
        }

        updateVirtualizedBlocks(options = {}) {
            if (!this.virtualization.isEnabled()) return;
            this.virtualization.updateMountedShells(
                block => this.onVirtualBlockMounted(block),
                shell => this.requestVirtualBlockHtml(shell),
                {
                    allowUnmount: options.allowUnmount !== false,
                    phase: options.phase || 'normal',
                    pruneHtmlCache: options.pruneHtmlCache === true
                }
            );
        }

        getBlockByIndex(index) {
            return this.contentRoot.querySelector('.latex-block[data-index="' + index + '"]');
        }

        getShellByIndex(index) {
            return this.contentRoot.querySelector('.latex-block-shell[data-index="' + index + '"]');
        }

        forEachDirtyBlock(payload, callback) {
            if (!payload.dirtyBlocks) return;
            Object.entries(payload.dirtyBlocks).forEach(([indexStr, html]) => callback(Number(indexStr), html));
        }

        insertElementsBefore(elements, referenceNode) {
            if (elements.length === 0) return;
            const fragment = document.createDocumentFragment();
            elements.forEach(element => fragment.appendChild(element));
            this.contentRoot.insertBefore(fragment, referenceNode);
        }

        getLatexBlockFromTarget(target) {
            if (!target) return null;
            if (target.classList?.contains('latex-block')) return target;
            return target.querySelector?.(':scope > .latex-block') || null;
        }

        async getTooltipContextBlocks(block) {
            const index = parseInt(block.getAttribute('data-index'));
            if (Number.isNaN(index)) {
                return [block.previousElementSibling, block, block.nextElementSibling]
                    .filter(candidate => candidate && candidate.classList.contains('latex-block'));
            }

            const indices = [index - 1, index, index + 1].filter(value => value >= 0);
            const results = await Promise.all(indices.map(index => this.ensureBlockMountedByIndex(index)));
            const blocks = results
                .map(result => this.getLatexBlockFromTarget(result.target))
                .filter(Boolean);

            return Array.from(new Set(blocks));
        }

        getBlockOrShellByIndex(index) {
            let target = this.getBlockByIndex(index);
            if (target) return target;

            const shell = this.getShellByIndex(index);
            if (!shell) return null;

            const mounted = this.virtualization.mountShell(shell, missingShell => this.requestVirtualBlockHtml(missingShell));
            if (mounted) {
                this.onVirtualBlockMounted(mounted);
                return mounted;
            }
            return shell;
        }

        waitForLayout() {
            return new Promise(resolve => {
                requestAnimationFrame(() => requestAnimationFrame(resolve));
            });
        }

        ensureShellMounted(shell) {
            const existingBlock = this.virtualization.getShellBlock(shell);
            if (existingBlock) {
                this.virtualization.refreshMountedShellHeight(shell);
                return Promise.resolve(existingBlock);
            }

            const mounted = this.virtualization.mountShell(
                shell,
                missingShell => this.requestVirtualBlockHtml(missingShell)
            );
            if (mounted) {
                this.onVirtualBlockMounted(mounted);
                return Promise.resolve(mounted);
            }

            return new Promise(resolve => {
                let resolved = false;
                const finish = block => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(timeout);
                    resolve(block || null);
                };
                const timeout = setTimeout(() => finish(null), 6000);
                const requested = this.requestVirtualBlockHtml(shell, {
                    forceMount: true,
                    onLoaded: finish
                });
                if (!requested) { finish(null); }
            });
        }

        async ensureBlockMountedByIndex(index) {
            const target = this.getBlockByIndex(index);
            if (target) return { target, mounted: false };

            const shell = this.getShellByIndex(index);
            if (!shell) return { target: null, mounted: false };

            const block = await this.ensureShellMounted(shell);
            return { target: block || shell, mounted: Boolean(block) };
        }

        async ensureAnchorMounted(anchorId) {
            const existing = document.getElementById(anchorId);
            if (existing) return existing;
            if (!this.virtualization.isEnabled()) return null;

            const shell = this.virtualization.findShellByAnchorId(anchorId);
            if (!shell) return null;

            await this.ensureShellMounted(shell);
            if (this.currentNumbering) {
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
            return document.getElementById(anchorId);
        }

        async onInternalLinkClick(event) {
            const link = event.target.closest('a');
            const href = link?.getAttribute('href');
            if (!href || !href.startsWith('#') || href.length <= 1) return;

            event.preventDefault();
            let anchorId = href.substring(1);
            try { anchorId = decodeURIComponent(anchorId); } catch {}

            const target = await this.ensureAnchorMounted(anchorId);
            if (!target) return;

            const targetY = target.getBoundingClientRect().top + window.scrollY - Math.round(window.innerHeight * 0.25);
            this.lockScrolling(900);
            window.scrollTo({ top: Math.max(0, targetY), behavior: 'auto' });

            const block = target.closest('.latex-block') || target.closest('.bib-item') || target;
            block.classList.add('jump-highlight');
            setTimeout(() => block.classList.remove('jump-highlight'), 1000);
        }

        requestVirtualBlockHtml(shell, options = {}) {
            if (!shell) return false;
            const requestOptions = typeof options === 'function'
                ? { onLoaded: options, forceMount: true }
                : options;

            const existingId = shell.getAttribute('data-html-request-id');
            if (existingId && this.pendingBlockHtmlRequests.has(existingId)) {
                const pending = this.pendingBlockHtmlRequests.get(existingId);
                if (requestOptions.onLoaded) { pending.callbacks.push(requestOptions.onLoaded); }
                pending.forceMount = pending.forceMount || requestOptions.forceMount === true;
                return true;
            }

            const index = parseInt(shell.getAttribute('data-index'));
            const hash = shell.getAttribute('data-block-hash') || '';
            if (Number.isNaN(index)) return false;

            const id = `block-${++this.blockHtmlRequestSeq}`;
            shell.setAttribute('data-html-request-id', id);
            this.pendingBlockHtmlRequests.set(id, {
                index,
                hash,
                forceMount: requestOptions.forceMount === true,
                callbacks: requestOptions.onLoaded ? [requestOptions.onLoaded] : []
            });
            this.debugStats.blockHtmlRequestsSent += 1;
            previewBridge.postMessage({ command: PreviewToHostCommand.RequestBlockHtml, id, index, hash });
            return true;
        }

        handleBlockHtml(message) {
            const pending = this.pendingBlockHtmlRequests.get(message.id);
            if (!pending) return;
            this.pendingBlockHtmlRequests.delete(message.id);
            if (message.error || !message.html) {
                const index = pending.index;
                const shell = this.getShellByIndex(index);
                if (shell) {
                    shell.removeAttribute('data-html-request-id');
                }
                pending.callbacks.forEach(callback => callback(null));
                return;
            }

            const index = typeof message.index === 'number' ? message.index : pending.index;
            const hash = message.hash || pending.hash || '';
            const htmlChars = message.html.length;
            this.debugStats.blockHtmlResponses += 1;
            this.debugStats.blockHtmlChars += htmlChars;
            this.debugStats.maxBlockHtmlChars = Math.max(this.debugStats.maxBlockHtmlChars, htmlChars);
            const shell = this.virtualization.storeBlockHtml(index, hash, message.html);
            if (shell) {
                shell.removeAttribute('data-html-request-id');
            }
            if (!shell) {
                pending.callbacks.forEach(callback => callback(null));
                return;
            }
            if (!pending.forceMount && !this.virtualization.isShellInMountRange(shell)) return;

            const block = this.virtualization.withViewportAnchorPreserved(() => this.virtualization.mountShell(
                shell,
                missingShell => this.requestVirtualBlockHtml(missingShell)
            ));
            if (block) { this.onVirtualBlockMounted(block); }
            pending.callbacks.forEach(callback => callback(block || null));
        }

        getPendingTikzContainers(root = document) {
            return Array.from(root.querySelectorAll('.tikz-container')).filter(container => {
                if (hasRenderedTikz(container) || container.getAttribute('data-tikz-state') === 'failed') return false;
                return !!container.querySelector(TIKZ_SCRIPT_SELECTOR);
            });
        }

        waitForTikzBatch(containers) {
            return new Promise(resolve => {
                let interval = null;
                let timeout = null;
                let resolved = false;
                const isSettled = container => (
                    !container.isConnected
                    || hasRenderedTikz(container)
                    || container.getAttribute('data-tikz-state') === 'failed'
                );
                const cleanup = () => {
                    document.removeEventListener('snaptex-tikz-settled', check, true);
                    if (interval) {
                        clearInterval(interval);
                    }
                    if (timeout) {
                        clearTimeout(timeout);
                    }
                };
                const check = () => {
                    if (resolved || !containers.every(isSettled)) return;

                    resolved = true;
                    cleanup();
                    resolve();
                };

                document.addEventListener('snaptex-tikz-settled', check, true);
                interval = setInterval(check, 100);
                timeout = setTimeout(() => {
                    if (resolved) return;

                    resolved = true;
                    cleanup();
                    resolve();
                }, TIKZ_BATCH_RENDER_TIMEOUT_MS);
                setTimeout(check, 0);
            });
        }

        async runTikzRenderBatch() {
            if (!this.contentRoot.querySelector(TIKZ_SCRIPT_SELECTOR) || window.tikzJaxFailed) return;

            const containers = this.getPendingTikzContainers(this.contentRoot);
            if (containers.length === 0 || window.tikzJaxFailed) return;
            await window.ensureTikzJaxLoaded();

            if (this.config.debugMemory) {
                console.log('[SnapTeX] Loading TikZJax for TikZ content...');
            }
            window.watchPendingTikzContainers(this.contentRoot, containers);
            const activated = window.activatePendingTikzScripts(this.contentRoot, containers);
            if (activated === 0) return;
            this.debugStats.tikzBatchRuns += 1;
            this.debugStats.tikzActivatedScripts += activated;
            this.logDomStats('after tikz activation');

            await this.waitForTikzBatch(containers);
            this.logDomStats('after tikz batch');
        }

        triggerTikzRendering() {
            const pendingTikz = this.contentRoot.querySelector(TIKZ_SCRIPT_SELECTOR);
            if (!pendingTikz || window.tikzJaxFailed) return;

            this.tikzRenderScheduler.request();
        }

        scheduleHeavyPreviewWork() {
            this.schedulePendingPdfRender();
            this.triggerTikzRendering();
        }

        scheduleInitialVirtualExpansion(includeHeavyWork) {
            if (this.initialExpansionFrame) {
                cancelAnimationFrame(this.initialExpansionFrame);
            }

            this.initialExpansionFrame = requestAnimationFrame(() => {
                this.initialExpansionFrame = requestAnimationFrame(() => {
                    this.initialExpansionFrame = null;
                    this.deferHeavyPreviewWork = true;
                    try {
                        this.updateVirtualizedBlocks({ allowUnmount: false, phase: 'normal' });
                    } finally {
                        this.deferHeavyPreviewWork = false;
                    }
                    this.logDomStats('after initial virtual expansion');
                    if (includeHeavyWork) {
                        this.scheduleHeavyPreviewWork();
                    }
                });
            });
        }

        onRenderComplete(savedScrollState) {
            const wasFirstLoad = this.isFirstLoad;
            const wasDeferringHeavyWork = this.deferHeavyPreviewWork;
            this.state = 'IDLE';
            document.body.classList.remove('preload-mode');
            if (this.pendingScroll) {
                this.executeScroll(this.pendingScroll);
                this.pendingScroll = null;
            } else if (!this.isFirstLoad) {
                this.restoreScrollState(savedScrollState);
            }
            this.isFirstLoad = false;
            this.deferHeavyPreviewWork = false;
            if (wasFirstLoad && this.virtualization.isEnabled()) {
                this.scheduleInitialVirtualExpansion(wasDeferringHeavyWork);
            } else if (wasDeferringHeavyWork) {
                this.scheduleHeavyPreviewWork();
            } else {
                this.schedulePendingPdfRender();
            }
        }

        handleScrollCommand(data) {
            if (this.state === 'RENDERING' || this.isFirstLoad) { this.pendingScroll = data; }
            else { this.executeScroll(data); }
        }

        onScroll() {
            if (this.state !== 'IDLE') return;
            const now = Date.now();
            if (now < this.previewLayoutSyncSuppressedUntil) return;
            if (now - this.lastScrollTime < this.config.autoScrollDelay) return;
            this.lastScrollTime = now;
            const blocks = document.querySelectorAll('.latex-block, .latex-block-shell');
            const viewCenter = window.innerHeight / 2;
            for (const block of blocks) {
                const rect = block.getBoundingClientRect();
                if (rect.top <= viewCenter && rect.bottom >= viewCenter) {
                    const index = parseInt(block.getAttribute('data-index'));
                    let ratio = 0;
                    if (rect.height > 0) {
                        const offset = viewCenter - rect.top;
                        ratio = Math.max(0, Math.min(1, offset / rect.height));
                    }
                    previewBridge.postMessage({ command: PreviewToHostCommand.SyncScroll, index: index, ratio: ratio });
                    break;
                }
            }
        }

        onDoubleClick(event) {
            const block = event.target.closest('.latex-block');
            if (block) {
                const index = block.getAttribute('data-index');
                if (index !== null) {
                    const rect = block.getBoundingClientRect();
                    const relativeY = event.clientY - rect.top;
                    const ratio = Math.max(0, Math.min(1, relativeY / rect.height));
                    let anchors = [];
                    const selection = window.getSelection();
                    if (selection && selection.toString().trim().length > 0) {
                        const selectedText = selection.toString().replace(/\s+/g, ' ').trim();
                        anchors = [selectedText, selectedText.split(' ')[0]];
                    } else if (document.caretRangeFromPoint) {
                        const range = document.caretRangeFromPoint(event.clientX, event.clientY);
                        if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
                            const text = range.startContainer.textContent || '';
                            const offset = range.startOffset;
                            const words = Array.from(text.matchAll(/\S+/g));
                            const wordIndex = words.findIndex(word => {
                                const start = word.index;
                                return offset >= start && offset <= start + word[0].length;
                            });
                            if (wordIndex >= 0) {
                                const clickedWord = words[wordIndex][0];
                                const context = words
                                    .slice(Math.max(0, wordIndex - 2), wordIndex + 3)
                                    .map(word => word[0])
                                    .join(' ');
                                anchors = [context, clickedWord];
                            }
                        }
                    }
                    const sourceAnchor = event.target.closest('[data-sn-src-start]');
                    previewBridge.postMessage({
                        command: PreviewToHostCommand.RevealLine,
                        index: parseInt(index),
                        ratio,
                        anchors,
                        sourceStart: sourceAnchor ? Number(sourceAnchor.getAttribute('data-sn-src-start')) : undefined,
                        sourceEnd: sourceAnchor ? Number(sourceAnchor.getAttribute('data-sn-src-end')) : undefined,
                        viewRatio: event.clientY / window.innerHeight
                    });
                }
            }
        }

        saveScrollState() {
            const blocks = document.querySelectorAll('.latex-block, .latex-block-shell');
            for (const block of blocks) {
                const rect = block.getBoundingClientRect();
                if (rect.bottom > 0 && rect.top < window.innerHeight) {
                    return { index: block.getAttribute('data-index'), ratio: -rect.top / rect.height };
                }
            }
            return null;
        }

        restoreScrollState(state) {
            if (!state || !state.index) return;
            const block = this.getBlockOrShellByIndex(state.index);
            if (block) {
                const newTop = block.getBoundingClientRect().top + window.scrollY;
                let targetY = state.ratio >= 0 ? newTop + (block.offsetHeight * state.ratio) : newTop;
                this.lockScrolling(500);
                window.scrollTo({ top: targetY, behavior: 'auto' });
            }
        }

        async executeScroll(data) {
            const { index, ratio, anchor, sourceStart, sourceEnd, auto, viewRatio = 0.5 } = data;
            const scrollSeq = ++this.scrollCommandSeq;

            const scrollToTarget = (target, useAnchor) => {
                if (!target?.isConnected) return false;
                const rect = target.getBoundingClientRect();
                const absoluteTop = rect.top + window.scrollY;
                let targetY = absoluteTop + (ratio || 0) * rect.height - (window.innerHeight * viewRatio);
                const sourceTarget = this.findSourceAnchorInBlock(target, sourceStart, sourceEnd);
                if (sourceTarget) {
                    const sourceRect = sourceTarget.getBoundingClientRect();
                    targetY = sourceRect.top + window.scrollY - (window.innerHeight * viewRatio);
                }
                if (!sourceTarget && useAnchor && anchor) {
                    const textTop = this.findTextOffsetInBlock(target, anchor);
                    if (textTop !== null) { targetY = textTop + window.scrollY - (window.innerHeight * viewRatio); }
                }
                const currentY = window.scrollY;
                const autoSkipThreshold = 12;
                if (Math.abs(currentY - targetY) < autoSkipThreshold && auto) { return true; }
                const lockTime = auto ? 600 : 1000;
                this.lockScrolling(lockTime);
                window.scrollTo({ top: targetY, behavior: 'auto' });
                return true;
            };

            const target = this.getBlockByIndex(index);
            if (target) {
                await this.waitForLayout();
                if (scrollSeq !== this.scrollCommandSeq) return;
                if (scrollToTarget(target, true) && !auto) {
                    target.classList.add('jump-highlight');
                    setTimeout(() => target.classList.remove('jump-highlight'), 1000);
                    const sourceTarget = this.findSourceAnchorInBlock(target, sourceStart, sourceEnd);
                    if (sourceTarget) this.highlightElement(sourceTarget);
                    if (anchor) this.highlightTextInNode(target, anchor);
                }
                return;
            }

            const shell = this.getShellByIndex(index);
            if (!shell) return;

            scrollToTarget(shell, false);
            const block = await this.ensureShellMounted(shell);
            if (scrollSeq !== this.scrollCommandSeq) return;

            const finalTarget = block || shell;
            await this.waitForLayout();
            if (scrollSeq !== this.scrollCommandSeq) return;

            if (scrollToTarget(finalTarget, Boolean(block)) && !auto) {
                finalTarget.classList.add('jump-highlight');
                setTimeout(() => finalTarget.classList.remove('jump-highlight'), 1000);
                const sourceTarget = block ? this.findSourceAnchorInBlock(block, sourceStart, sourceEnd) : null;
                if (sourceTarget) this.highlightElement(sourceTarget);
                if (block && anchor) this.highlightTextInNode(block, anchor);
            }
        }

        shouldReplaceBlock(oldBlock, newBlock, preserveUnchangedBlocks) {
            if (!preserveUnchangedBlocks) return true;

            const oldHash = oldBlock.getAttribute('data-block-hash');
            const newHash = newBlock.getAttribute('data-block-hash');
            if (!oldHash || !newHash) return true;

            return oldHash !== newHash;
        }

        smartFullUpdateFromBlocks(htmls, preserveUnchangedBlocks = true) {
            const newElements = htmls
                .map(html => parseFirstElementFromHtml(html))
                .filter(Boolean);
            this.smartFullUpdateElements(newElements, preserveUnchangedBlocks);
        }

        smartFullUpdateFromBlockMetadata(blocks, options = {}) {
            this.virtualization.replaceContentWithBlockMetadata(
                blocks,
                block => this.onVirtualBlockMounted(block),
                shell => this.requestVirtualBlockHtml(shell),
                options
            );
        }

        smartFullUpdateElements(newElements, preserveUnchangedBlocks = true) {
            if (this.virtualization.isEnabled()) {
                this.virtualization.replaceContentWithShells(newElements, block => this.onVirtualBlockMounted(block));
                return;
            }

            const oldElements = Array.from(this.contentRoot.children);
            const maxLen = Math.max(newElements.length, oldElements.length);
            for (let i = 0; i < maxLen; i++) {
                const newEl = newElements[i];
                const oldEl = oldElements[i];
                if (!newEl) {
                    if (oldEl) {
                        this.virtualization.rememberBlockHeight(oldEl);
                        oldEl.remove();
                    }
                    continue;
                }
                if (!oldEl) { this.contentRoot.appendChild(newEl); continue; }
                if (this.shouldReplaceBlock(oldEl, newEl, preserveUnchangedBlocks)) {
                    this.replaceBlockPreservingTikz(oldEl, newEl);
                }
            }
            this.virtualization.pruneCachesFromContent();
        }

        applyPatch(payload) {
            if (this.virtualization.isEnabled()) {
                this.applyVirtualPatch(payload);
                return;
            }

            const { start, deleteCount, htmls = [], shift = 0 } = payload;
            const targetIndex = start + deleteCount;
            const referenceNode = this.contentRoot.children[targetIndex] || null;
            const staleTikzByIndex = new Map();

            for (let i = 0; i < deleteCount; i++) {
                const block = this.contentRoot.children[start + i];
                this.rememberStaleTikzPreviews(block, staleTikzByIndex);
            }

            for (let i = 0; i < deleteCount; i++) {
                if (this.contentRoot.children[start]) this.contentRoot.removeChild(this.contentRoot.children[start]);
            }
            const insertedBlocks = htmls.map(html => parseFirstElementFromHtml(html)).filter(Boolean);
            this.insertElementsBefore(insertedBlocks, referenceNode);
            insertedBlocks.forEach(block => {
                const index = block.getAttribute('data-index');
                this.attachStaleTikzPreviews(block, staleTikzByIndex.get(index));
            });
            if (shift !== 0) {
                let node = this.contentRoot.children[start + htmls.length];
                while (node) {
                    const oldIdx = parseInt(node.getAttribute('data-index'));
                    if (!isNaN(oldIdx)) { node.setAttribute('data-index', oldIdx + shift); }
                    node = node.nextElementSibling;
                }
            }
            this.forEachDirtyBlock(payload, (idx, html) => {
                const targetBlock = this.getBlockByIndex(idx);
                const replacement = targetBlock ? parseFirstElementFromHtml(html) : null;
                if (replacement) this.replaceBlockPreservingTikz(targetBlock, replacement);
            });
            this.virtualization.pruneCachesFromContent();
        }

        applyVirtualPatch(payload) {
            const { start, deleteCount, htmls = [], shift = 0 } = payload;
            const referenceNode = this.contentRoot.children[start + deleteCount] || null;
            const staleTikzByIndex = new Map();

            for (let i = 0; i < deleteCount; i++) {
                const shell = this.contentRoot.children[start];
                if (!shell) break;
                this.rememberStaleTikzPreviews(shell, staleTikzByIndex);
                this.virtualization.unobserveShell(shell);
                shell.remove();
            }

            const insertedShells = [];
            htmls.forEach(html => {
                const block = parseFirstElementFromHtml(html);
                if (!block) return;

                const shell = this.virtualization.createShellForBlock(block);
                const index = block.getAttribute('data-index');
                this.stashStaleTikzPreviewsOnShell(shell, staleTikzByIndex.get(index));
                insertedShells.push(shell);
            });

            this.insertElementsBefore(insertedShells, referenceNode);

            if (shift !== 0) {
                this.virtualization.remapShellIndicesFromDomPosition(start + insertedShells.length, shift);
            }

            this.forEachDirtyBlock(payload, (idx, html) => {
                const shell = this.getShellByIndex(idx);
                const replacement = shell ? parseFirstElementFromHtml(html) : null;
                if (!replacement) return;

                const previews = this.collectTikzPreviews(shell);
                const newShell = this.virtualization.createShellForBlock(replacement);
                this.stashStaleTikzPreviewsOnShell(newShell, previews);
                this.virtualization.unobserveShell(shell);
                shell.replaceWith(newShell);
            });

            this.updateVirtualizedBlocks();
            this.virtualization.pruneCachesFromContent();
        }

        applyNumbering(data) {
            if (!data) return;
            const { blocks, labels } = data;
            for (const [idxStr, counts] of Object.entries(blocks)) {
                const idx = parseInt(idxStr);
                const blockEl = this.getBlockByIndex(idx);
                if (!blockEl) continue;
                const fill = (type, values) => {
                    if (!values || !values.length) return;
                    const spans = blockEl.querySelectorAll('.sn-cnt[data-type="' + type + '"]');
                    spans.forEach((span, i) => { if (values[i]) span.textContent = values[i]; });
                };
                fill('eq', counts.eq); fill('fig', counts.fig); fill('tbl', counts.tbl);
                fill('alg', counts.alg); fill('sec', counts.sec); fill('thm', counts.thm);
            }
            if (labels) {
                const refs = document.querySelectorAll('.sn-ref');
                refs.forEach(ref => {
                    const key = ref.getAttribute('data-key');
                    if (key && labels[key]) { ref.textContent = labels[key]; } else { ref.textContent = "??"; }
                });
            }
        }

        initPdfObserver() {
            if (!('IntersectionObserver' in window)) return;
            const rootMargin = `${viewportHeightToPixels(PDF_RENDER_MARGIN_VH)}px`;
            this.pdfObserver = new IntersectionObserver(entries => {
                entries.forEach(entry => {
                    if (!entry.isIntersecting) return;
                    const canvas = entry.target;
                    this.requestPdfCanvas(canvas);
                    this.pdfObserver.unobserve(canvas);
                    canvas.removeAttribute('data-pdf-observed');
                });
            }, { rootMargin });
        }

        requestPdfCanvas(canvas) {
            const path = canvas.getAttribute('data-req-path');
            const id = canvas.id;
            if (path && id && !canvas.getAttribute('data-rendered') && !canvas.getAttribute('data-requested')) {
                window.renderPdfToCanvas(path, id);
            }
        }

        releasePdfCanvasBitmap(canvas) {
            if (canvas.getAttribute('data-rendered') !== 'true' || canvas.getAttribute('data-pdf-released') === 'true') return;

            const rect = canvas.getBoundingClientRect();
            if (rect.height > 0) {
                canvas.style.height = `${Math.ceil(rect.height)}px`;
            }
            canvas.width = 0;
            canvas.height = 0;
            canvas.removeAttribute('data-rendered');
            canvas.removeAttribute('data-requested');
            canvas.setAttribute('data-pdf-released', 'true');
        }

        schedulePendingPdfRender() {
            if (this.pdfRenderTimer) clearTimeout(this.pdfRenderTimer);

            let timeout;
            const run = () => {
                if (this.pdfRenderTimer !== timeout) return;
                if (this.pdfRenderTimer) {
                    clearTimeout(this.pdfRenderTimer);
                    this.pdfRenderTimer = null;
                }
                this.renderPendingPdfs();
                this.logDomStats('after renderPendingPdfs');
            };

            requestAnimationFrame(() => {
                requestAnimationFrame(run);
            });

            timeout = setTimeout(run, 250);
            this.pdfRenderTimer = timeout;
        }

        renderPendingPdfs() {
            this.debugStats.pdfRenderRuns += 1;
            const pdfCanvases = document.querySelectorAll('canvas[data-req-path]');
            const renderMargin = viewportHeightToPixels(PDF_RENDER_MARGIN_VH);
            const releaseMargin = viewportHeightToPixels(PDF_RELEASE_MARGIN_VH);
            pdfCanvases.forEach(canvas => {
                if (!isElementWithinViewportMargins(canvas, releaseMargin)) {
                    this.releasePdfCanvasBitmap(canvas);
                }
                if (canvas.getAttribute('data-rendered') || canvas.getAttribute('data-requested')) return;
                if (isElementWithinViewportMargins(canvas, renderMargin)) {
                    this.requestPdfCanvas(canvas);
                    return;
                }
                if (this.pdfObserver) {
                    if (!canvas.getAttribute('data-pdf-observed')) {
                        canvas.setAttribute('data-pdf-observed', 'true');
                        this.pdfObserver.observe(canvas);
                    }
                } else {
                    this.requestPdfCanvas(canvas);
                }
            });
        }

        findTextRangeInNode(rootElement, text) {
            if (!text || text.length < 3) return null;
            const walker = document.createTreeWalker(rootElement, NodeFilter.SHOW_TEXT, {
                acceptNode: (node) => {
                    if (node.parentElement && node.parentElement.closest('.katex')) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            });
            let node;
            while (node = walker.nextNode()) {
                const val = node.nodeValue;
                const index = val.indexOf(text);
                if (index >= 0) {
                    const range = document.createRange();
                    range.setStart(node, index);
                    range.setEnd(node, index + text.length);
                    return range;
                }
            }
            return null;
        }

        highlightTextInNode(rootElement, text) {
            const range = this.findTextRangeInNode(rootElement, text);
            if (!range) return false;
            const span = document.createElement('span');
            span.className = 'highlight-word';
            range.surroundContents(span);
            setTimeout(() => {
                const parent = span.parentNode;
                if (parent) {
                    parent.replaceChild(document.createTextNode(span.textContent), span);
                    parent.normalize();
                }
            }, 2000);
            return true;
        }

        highlightElement(element) {
            element.classList.add('highlight-word');
            setTimeout(() => element.classList.remove('highlight-word'), 2000);
        }

        findSourceAnchorInBlock(rootElement, sourceStart, sourceEnd) {
            if (typeof sourceStart !== 'number' || Number.isNaN(sourceStart)) return null;
            const anchors = Array.from(rootElement.querySelectorAll('[data-sn-src-start]'));
            return anchors.find(anchor => {
                const start = Number(anchor.getAttribute('data-sn-src-start'));
                const end = Number(anchor.getAttribute('data-sn-src-end'));
                return start === sourceStart && (typeof sourceEnd !== 'number' || Number.isNaN(sourceEnd) || end === sourceEnd);
            }) || null;
        }

        findTextOffsetInBlock(rootElement, text) {
            const range = this.findTextRangeInNode(rootElement, text);
            return range ? range.getBoundingClientRect().top : null;
        }
    }

    new PreviewController();


