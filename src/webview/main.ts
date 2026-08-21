// @ts-nocheck
/* eslint-disable curly */
import { CoalescingTaskScheduler } from './scheduler';
import { BLOCK_VIRTUALIZATION_CLEANUP_DELAY_MS, BlockVirtualizationController, HEIGHT_MEASUREMENT_CANCEL_EVENT, isElementWithinViewportMargins, parseFirstElementFromHtml, viewportHeightToPixels } from './virtualization';
import { PageLayoutController } from './pagination';
import { PREVIEW_RESIZE_ACTIVE_CLASS, ViewportAnchorController } from './viewport';
import { hasRenderedTikz, setTikzContainerState, TIKZ_BATCH_RENDER_TIMEOUT_MS, TIKZ_RENDER_DEBOUNCE_MS, TIKZ_SCRIPT_SELECTOR } from './tikz';
import { HostToPreviewCommand, MAX_BLOCK_HTML_BATCH_SIZE, PreviewToHostCommand } from '../preview-messages';
import { getPreviewBridge } from './bridge';
const previewBridge = getPreviewBridge();
    const PREVIEW_LAYOUT_WIDTH_TOLERANCE = 0.01;
    const PREVIEW_RESIZE_SETTLE_DELAY_MS = 150;
    const HEIGHT_WARMUP_BATCH_SIZE = 8;
    const PREVIEW_STYLE_PROPERTIES = [
        ['fontSize', '--snaptex-preview-base-font-size', 'font-size'],
        ['lineHeight', '--snaptex-preview-line-height', 'line-height'],
        ['contentMaxWidth', '--snaptex-preview-content-max-width', 'max-width'],
        ['fontFamily', '--snaptex-preview-font-family-setting', 'font-family']
    ];
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

            if (this.showTimer !== null) clearTimeout(this.showTimer);
            this.anchorY = anchorY ?? null;

            this.showTimer = setTimeout(() => {
                this.showTimer = null;
                this.onLinkEnter(link);
            }, 200);
        }

        cancelShow() {
            if (this.showTimer !== null) {
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

            if (this.hideTimer !== null) clearTimeout(this.hideTimer);
            this.hideTimer = setTimeout(() => {
                this.hideTimer = null;
                this.hide();
            }, 300);
        }

        clearHideTimer() {
            if (this.hideTimer !== null) {
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
            this.renderCompletionSeq = 0;
            this.previewLayoutSyncSuppressedUntil = 0;
            this.lastLayoutWidth = this.getPageWidth();
            this.virtualUpdateFrame = null;
            this.virtualCleanupTimer = null;
            this.config = {
                autoScrollDelay: 100,
                debugMemory: false
            };
            this.currentNumbering = null;
            this.blockHtmlRequestSeq = 0;
            this.measurementResourceSeq = 0;
            this.pendingBlockHtmlRequests = new Map();
            this.heightWarmupGeneration = 0;
            this.heightWarmupTimer = null;
            this.heightWarmupBusy = false;
            this.heightWarmupCursor = null;
            this.heightWarmupEndIndex = null;
            this.heightWarmupMeasurementWidth = null;
            this.heightWarmupFailedKeys = new Set();
            this.heightWarmupHtml = new Map();
            this.interactiveResizeActive = false;
            this.interactiveResizeTimer = null;
            this.pdfObserver = null;
            this.pdfRenderTimer = null;
            this.deferHeavyPreviewWork = false;
            this.initialExpansionFrame = null;
            this.typographyMeasurementHost = null;
            this.viewportAnchor = new ViewportAnchorController();
            this.virtualization = new BlockVirtualizationController(this.contentRoot, this.viewportAnchor);
            this.pagination = new PageLayoutController(this.contentRoot, this.viewportAnchor);
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

            this.syncPreviewTypography();
            new TooltipManager();

            this.initPdfObserver();
            this.bindEvents();
            previewBridge.postMessage({ command: PreviewToHostCommand.PreviewLoaded });
        }

        bindEvents() {
            window.addEventListener('message', event => this.onMessage(event));
            const deferHeightWarmup = () => this.deferHeightWarmup();
            ['wheel', 'touchmove', 'pointerdown'].forEach(eventName => {
                window.addEventListener(eventName, deferHeightWarmup, { passive: true });
            });
            window.addEventListener('keydown', event => {
                if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
                    deferHeightWarmup();
                }
            });
            window.addEventListener('scroll', () => {
                if (this.interactiveResizeActive) return;
                this.viewportAnchor.pin(this.virtualization.getShells());
                this.requestVirtualizedUpdate({ allowUnmount: false });
                this.scheduleVirtualizedCleanup();
                this.onScroll();
            });
            window.addEventListener('resize', () => this.onPreviewResize());
            if (typeof ResizeObserver !== 'undefined' && this.contentRoot) {
                this.previewResizeObserver = new ResizeObserver(() => this.onPreviewResize());
                this.previewResizeObserver.observe(this.contentRoot);
            }
            document.addEventListener('dblclick', event => this.onDoubleClick(event));
            document.addEventListener('click', event => this.onInternalLinkClick(event));
        }

        getSyncSuppressionDuration() {
            return Math.max(500, this.config.autoScrollDelay + 300);
        }

        getPageWidth() {
            const rect = this.contentRoot?.getBoundingClientRect();
            return rect && rect.width > 0 ? rect.width : 0;
        }

        beginInteractiveResize() {
            this.clearInteractiveResizeTimer();
            if (this.interactiveResizeActive) return;
            this.cancelHeightWarmup();
            this.interactiveResizeActive = true;
            document.body.classList.add(PREVIEW_RESIZE_ACTIVE_CLASS);
            this.previewLayoutSyncSuppressedUntil = Date.now() + this.getSyncSuppressionDuration();
            if (!this.viewportAnchor.isPinned()) {
                this.viewportAnchor.pin(this.virtualization.getShells());
            }
            previewBridge.postMessage({ command: PreviewToHostCommand.PreviewLayoutChanged });
        }

        clearInteractiveResizeTimer() {
            if (this.interactiveResizeTimer === null) return;
            clearTimeout(this.interactiveResizeTimer);
            this.interactiveResizeTimer = null;
        }

        finishInteractiveResize(update = () => {}) {
            this.clearInteractiveResizeTimer();
            if (!this.interactiveResizeActive) {
                update();
                return;
            }
            this.previewLayoutSyncSuppressedUntil = Date.now() + this.getSyncSuppressionDuration();
            previewBridge.postMessage({ command: PreviewToHostCommand.PreviewLayoutChanged });
            try {
                this.viewportAnchor.preserve([], update);
            } finally {
                this.interactiveResizeActive = false;
                document.body.classList.remove(PREVIEW_RESIZE_ACTIVE_CLASS);
            }
            this.applySettledPreviewResize();
            this.refreshViewportAnchorAfterLayout();
        }

        refreshViewportAnchorAfterLayout() {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (!this.interactiveResizeActive && this.heightWarmupCursor === null) {
                    this.viewportAnchor.pin(this.virtualization.getShells());
                }
            }));
        }

        syncPreviewTypography() {
            if (!this.contentRoot) return;
            if (!this.typographyMeasurementHost?.isConnected) {
                const host = document.createElement('div');
                const probe = document.createElement('span');
                Object.assign(host.style, {
                    position: 'fixed',
                    left: '-100000px',
                    top: '0',
                    visibility: 'hidden',
                    pointerEvents: 'none',
                    contain: 'strict',
                    containerType: 'size'
                });
                host.appendChild(probe);
                document.body.appendChild(host);
                this.typographyMeasurementHost = host;
            }
            const rect = this.contentRoot.getBoundingClientRect();
            const host = this.typographyMeasurementHost;
            const style = getComputedStyle(this.contentRoot);
            const measurementWidth = this.pagination.syncContentWidth()
                ?? this.virtualization.getMeasurementWidth(style);
            host.style.width = `${measurementWidth}px`;
            host.style.height = `${Math.max(1, rect.height)}px`;
            const probe = host.firstElementChild;
            probe.style.fontSize = style.getPropertyValue('--base-font-size');
            const fontSize = getComputedStyle(probe).fontSize;
            if (!fontSize) return;
            document.documentElement.style.setProperty('--snaptex-preview-text-size', fontSize);
            return {
                measurementWidth,
                fontScale: this.virtualization.setFontSize(fontSize)
            };
        }

        applyPreviewStyle(style) {
            if (!style) return false;
            let changed = false;
            for (const [setting, variable, property] of PREVIEW_STYLE_PROPERTIES) {
                const value = typeof style[setting] === 'string' ? style[setting].trim() : '';
                const nextValue = value && CSS.supports(property, value) ? value : '';
                if (document.documentElement.style.getPropertyValue(variable) === nextValue) continue;
                if (nextValue) {
                    document.documentElement.style.setProperty(variable, nextValue);
                } else {
                    document.documentElement.style.removeProperty(variable);
                }
                changed = true;
            }
            return changed;
        }

        applySettledPreviewResize() {
            const layoutWidth = this.getPageWidth();
            if (layoutWidth <= 0) {
                this.cancelHeightWarmup();
                this.viewportAnchor.clear();
                return;
            }
            let typography;
            this.viewportAnchor.preserve(this.virtualization.getShells(), () => {
                typography = this.syncPreviewTypography();
                this.updateVirtualizedBlocks({ allowUnmount: true });
            });
            const previousWidth = this.lastLayoutWidth;
            this.lastLayoutWidth = layoutWidth;
            if (this.isFirstLoad) {
                return;
            }
            if (Math.abs(layoutWidth - previousWidth) / Math.max(layoutWidth, previousWidth)
                    < PREVIEW_LAYOUT_WIDTH_TOLERANCE) {
                return;
            }
            const shells = this.virtualization.getShells();
            if (typography && shells.length > 0
                && shells.every(shell => this.virtualization.hasMeasuredHeight(shell, typography.measurementWidth))) {
                this.heightWarmupFailedKeys.clear();
                this.pagination.rescaleHeights(typography.fontScale);
                return;
            }
            this.heightWarmupFailedKeys.clear();
            this.scheduleHeightWarmup(250);
            if (!this.virtualization.isEnabled()) {this.pagination.refresh(true);}
        }

        onPreviewResize() {
            const layoutWidth = this.getPageWidth();
            if (layoutWidth <= 0) {
                this.cancelHeightWarmup();
                this.viewportAnchor.clear();
                return;
            }
            if (!this.interactiveResizeActive && Math.abs(layoutWidth - this.lastLayoutWidth) < 1) return;

            // VS Code owns its splitter, so infer the same lifecycle from observed width changes.
            this.beginInteractiveResize();
            this.viewportAnchor.compensatePinnedPosition();
            this.clearInteractiveResizeTimer();
            this.interactiveResizeTimer = setTimeout(() => {
                this.interactiveResizeTimer = null;
                this.finishInteractiveResize();
            }, PREVIEW_RESIZE_SETTLE_DELAY_MS);
        }

        lockScrolling(duration) {
            this.state = 'SCROLLING_AUTO';
            if (this.scrollTimeout !== null) clearTimeout(this.scrollTimeout);
            this.scrollTimeout = setTimeout(() => {
                this.scrollTimeout = null;
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
                    const config = event.data.config;
                    const styleChanged = this.applyPreviewStyle(config.style);
                    if (typeof config.autoScrollDelay === 'number') {
                        this.config.autoScrollDelay = Math.max(0, config.autoScrollDelay);
                    }
                    if (typeof config.debugMemory === 'boolean') {
                        this.config.debugMemory = config.debugMemory;
                    }
                    const virtualMode = config.virtualMode !== false;
                    const virtualModeChanged = virtualMode !== this.virtualization.isEnabled();
                    this.virtualization.setEnabled(virtualMode);
                    const paged = config.previewLayout === 'paged';
                    this.pagination.setEnabled(paged);
                    if (styleChanged) {
                        this.syncPreviewTypography();
                        this.virtualization.resetHeightCache();
                        this.heightWarmupFailedKeys.clear();
                        if (!virtualMode) {this.pagination.refresh(true);}
                    }
                    if (virtualMode && (virtualModeChanged || styleChanged)) {
                        this.scheduleHeightWarmup(styleChanged ? 150 : 400);
                    } else if (!virtualMode) {
                        this.cancelHeightWarmup();
                    }
                    this.updateVirtualizedBlocks({ allowUnmount: true });
                    break;
            }
        }

        handleUpdate(payload) {
            this.logPayloadStats(payload);
            const resetHeightState = payload.resetPreviewState
                || (payload.type === 'full' && payload.preserveUnchangedBlocks === false);
            this.cancelHeightWarmup(resetHeightState);
            this.clearPendingBlockHtmlRequests();
            if (payload.resetPreviewState) {
                this.resetPreviewRuntimeState();
            }
            if (payload.numbering) {
                this.currentNumbering = payload.numbering;
            }
            const renderSeq = ++this.renderCompletionSeq;
            this.state = 'RENDERING';
            const scrollState = this.saveScrollState();
            if (payload.type === 'full') {
                this.deferHeavyPreviewWork = this.isFirstLoad && !!payload.blocks && this.virtualization.isEnabled();
                document.body.classList.add('preload-mode');
                if (!payload.resetPreviewState && payload.preserveUnchangedBlocks === false && this.virtualization.isEnabled()) {
                    this.virtualization.resetCaches();
                }
                if (payload.blocks && this.virtualization.isEnabled()) {
                    this.virtualization.replaceContentWithBlockMetadata(
                        payload.blocks,
                        block => this.onVirtualBlockMounted(block),
                        shell => this.requestVirtualBlockHtml(shell),
                        { phase: this.deferHeavyPreviewWork ? 'initial' : 'normal' }
                    );
                } else if (payload.htmls) {
                    this.smartFullUpdate(payload.htmls, payload.preserveUnchangedBlocks !== false);
                }
                this.logDomStats('after full update');
                this.pagination.refresh();
                document.fonts.ready
                    .then(() => this.waitForLayout())
                    .then(() => this.onRenderComplete(scrollState, renderSeq));
            } else if (payload.type === 'patch') {
                this.previewLayoutSyncSuppressedUntil = Date.now() + this.getSyncSuppressionDuration();
                const paginationRange = this.virtualization.isEnabled()
                    ? this.getPatchPaginationRange(payload)
                    : undefined;
                this.applyPatch(payload);
                if (this.virtualization.isEnabled()) {
                    this.scheduleHeightWarmup(0, paginationRange);
                } else {
                    this.pagination.refresh();
                }
                this.logDomStats('after patch update');
                void this.waitForLayout().then(() => this.onPatchComplete(scrollState, renderSeq));
            }
            if (payload.numbering) {
                requestAnimationFrame(() => this.applyNumbering(payload.numbering));
            }
            if (!this.deferHeavyPreviewWork && !this.virtualization.isEnabled()) {
                this.scheduleHeavyPreviewWork();
            }
        }

        resetPreviewRuntimeState() {
            this.virtualization.resetCaches();
            this.pagination.reset();
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
            this.pagination.transferPatchLayout([oldBlock], [newBlock]);
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
            this.heightWarmupFailedKeys.delete(this.virtualization.getBlockKey(shell || block));
            this.attachStaleTikzPreviews(block, this.consumeStaleTikzPreviewsFromShell(shell));

            this.fillCurrentNumbering(block);
            if (!this.deferHeavyPreviewWork) {
                void this.stabilizeMountedBlockHeight(block);
            }
        }

        async stabilizeMountedBlockHeight(block) {
            const shell = block?.closest('.latex-block-shell');
            if (!shell) return undefined;
            if (block._snaptexHeightStabilization) return block._snaptexHeightStabilization;
            block._snaptexHeightStabilization = (async () => {
                const settled = await this.prepareBlockHeightResources(block, false);
                if (!settled || this.virtualization.getShellBlock(shell) !== block) return undefined;
                return this.virtualization.settleMountedShellHeight(shell);
            })();
            try {
                return await block._snaptexHeightStabilization;
            } finally {
                delete block._snaptexHeightStabilization;
            }
        }

        requestVirtualizedUpdate(options = {}) {
            if (!this.virtualization.isEnabled() || this.virtualUpdateFrame !== null) return;

            this.virtualUpdateFrame = requestAnimationFrame(() => {
                this.virtualUpdateFrame = null;
                this.updateVirtualizedBlocks(options);
            });
        }

        scheduleVirtualizedCleanup() {
            if (this.virtualCleanupTimer !== null) {
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
                    pruneHtmlCache: options.pruneHtmlCache === true,
                    preserveViewportAnchor: !this.pagination.isEnabled() || this.viewportAnchor.isPinned()
                }
            );
        }

        getBlockByIndex(index) {
            return this.contentRoot.querySelector('.latex-block[data-index="' + index + '"]');
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

            const shell = this.virtualization.findMatchingShell(index);
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
            if (existingBlock) return Promise.resolve(existingBlock);

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
                    onMounted: finish
                });
                if (!requested) { finish(null); }
            });
        }

        async ensureBlockMountedByIndex(index) {
            const target = this.getBlockByIndex(index);
            if (target) return { target, mounted: false };

            const shell = this.virtualization.findMatchingShell(index);
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

        registerVirtualBlockHtmlRequest(shell, options = {}) {
            if (!shell) return undefined;
            const existingId = shell.getAttribute('data-html-request-id');
            if (existingId && this.pendingBlockHtmlRequests.has(existingId)) {
                const pending = this.pendingBlockHtmlRequests.get(existingId);
                if (options.onMounted) { pending.mountCallbacks.push(options.onMounted); }
                if (options.onHtml) { pending.htmlCallbacks.push(options.onHtml); }
                pending.mountRequested ||= options.measureOnly !== true;
                pending.forceMount ||= options.forceMount === true;
                return null;
            }

            const index = parseInt(shell.getAttribute('data-index'));
            const hash = shell.getAttribute('data-block-hash') || '';
            if (Number.isNaN(index)) return undefined;

            const id = `block-${++this.blockHtmlRequestSeq}`;
            shell.setAttribute('data-html-request-id', id);
            this.pendingBlockHtmlRequests.set(id, {
                index,
                hash,
                mountRequested: options.measureOnly !== true,
                forceMount: options.forceMount === true,
                mountCallbacks: options.onMounted ? [options.onMounted] : [],
                htmlCallbacks: options.onHtml ? [options.onHtml] : []
            });
            this.debugStats.blockHtmlRequestsSent += 1;
            return { id, index, hash };
        }

        requestVirtualBlockHtml(shell, options = {}) {
            const request = this.registerVirtualBlockHtmlRequest(shell, options);
            if (request === undefined) return false;
            if (request) {
                previewBridge.postMessage({ command: PreviewToHostCommand.RequestBlockHtml, requests: [request] });
            }
            return true;
        }

        clearPendingBlockHtmlRequests() {
            for (const pending of this.pendingBlockHtmlRequests.values()) {
                pending.mountCallbacks.forEach(callback => callback(null));
                pending.htmlCallbacks.forEach(callback => callback(null));
            }
            this.pendingBlockHtmlRequests.clear();
            this.contentRoot.querySelectorAll('.latex-block-shell[data-html-request-id]')
                .forEach(shell => shell.removeAttribute('data-html-request-id'));
        }

        handleBlockHtml(message) {
            const pending = this.pendingBlockHtmlRequests.get(message.id);
            if (!pending) return;
            this.pendingBlockHtmlRequests.delete(message.id);
            const resolveHtmlCallbacks = html => pending.htmlCallbacks.forEach(callback => callback(html));
            if (message.error || !message.html) {
                const shell = this.virtualization.findMatchingShell(pending.index, pending.hash);
                if (shell?.getAttribute('data-html-request-id') === message.id) {
                    shell.removeAttribute('data-html-request-id');
                }
                pending.mountCallbacks.forEach(callback => callback(null));
                resolveHtmlCallbacks(null);
                return;
            }

            const index = typeof message.index === 'number' ? message.index : pending.index;
            const hash = message.hash || pending.hash || '';
            const htmlChars = message.html.length;
            this.debugStats.blockHtmlResponses += 1;
            this.debugStats.blockHtmlChars += htmlChars;
            this.debugStats.maxBlockHtmlChars = Math.max(this.debugStats.maxBlockHtmlChars, htmlChars);
            const shell = pending.mountRequested
                ? this.virtualization.storeBlockHtml(index, hash, message.html)
                : this.virtualization.findMatchingShell(index, hash);
            if (shell?.getAttribute('data-html-request-id') === message.id) {
                shell.removeAttribute('data-html-request-id');
            }
            if (!shell) {
                pending.mountCallbacks.forEach(callback => callback(null));
                resolveHtmlCallbacks(message.html);
                return;
            }
            let block = null;
            if (pending.mountRequested && (pending.forceMount || this.virtualization.isShellInMountRange(shell))) {
                block = this.virtualization.withViewportAnchorPreserved(() => this.virtualization.mountShell(
                    shell,
                    missingShell => this.requestVirtualBlockHtml(missingShell)
                ));
                if (block) { this.onVirtualBlockMounted(block); }
            }
            pending.mountCallbacks.forEach(callback => callback(block || null));
            resolveHtmlCallbacks(message.html);
        }

        invalidateHeightWarmup() {
            this.heightWarmupGeneration += 1;
            this.heightWarmupHtml.clear();
            if (this.heightWarmupTimer !== null) {
                clearTimeout(this.heightWarmupTimer);
                this.heightWarmupTimer = null;
            }
            this.virtualization.cancelHeightMeasurement();
        }

        cancelHeightWarmup(clearFailures = false) {
            this.invalidateHeightWarmup();
            this.heightWarmupCursor = null;
            this.heightWarmupEndIndex = null;
            this.heightWarmupMeasurementWidth = null;
            this.pagination.cancelIncremental();
            if (clearFailures) { this.heightWarmupFailedKeys.clear(); }
        }

        scheduleHeightWarmup(delay = 400, range = {}) {
            if (!this.virtualization.isEnabled() || this.isFirstLoad || this.contentRoot.children.length === 0) return;

            this.invalidateHeightWarmup();
            const generation = this.heightWarmupGeneration;
            const lastIndex = Math.max(0, this.contentRoot.children.length - 1);
            const startIndex = Math.min(Math.max(0, range.startIndex ?? 0), lastIndex);
            const lastChangedIndex = Math.min(
                Math.max(startIndex, range.lastChangedIndex ?? lastIndex),
                lastIndex
            );
            this.lastLayoutWidth = this.getPageWidth();
            this.heightWarmupCursor = this.pagination.beginIncremental(startIndex, lastChangedIndex);
            this.heightWarmupEndIndex = this.pagination.isEnabled() ? lastIndex : lastChangedIndex;
            this.heightWarmupMeasurementWidth = this.virtualization.getMeasurementWidth();
            if (this.heightWarmupFailedKeys.size > 0) {
                const activeKeys = new Set(this.virtualization.getShells().map(shell => this.virtualization.getBlockKey(shell)));
                for (const key of this.heightWarmupFailedKeys) {
                    if (!activeKeys.has(key)) { this.heightWarmupFailedKeys.delete(key); }
                }
            }
            this.scheduleHeightWarmupStep(generation, delay);
        }

        deferHeightWarmup(delay = BLOCK_VIRTUALIZATION_CLEANUP_DELAY_MS) {
            if (!this.virtualization.isEnabled() || this.heightWarmupCursor === null) return;

            this.invalidateHeightWarmup();
            this.scheduleHeightWarmupStep(this.heightWarmupGeneration, delay);
        }

        scheduleHeightWarmupStep(generation, delay = 0) {
            this.heightWarmupTimer = setTimeout(() => {
                this.heightWarmupTimer = null;
                const run = () => {
                    if (generation !== this.heightWarmupGeneration) return;
                    this.runHeightWarmupStep(generation);
                };
                if (delay > 0 && typeof window.requestIdleCallback === 'function') {
                    window.requestIdleCallback(run, { timeout: 1000 });
                } else {
                    run();
                }
            }, delay);
        }

        getHeightWarmupRequestKey(shell) {
            return `${shell.getAttribute('data-index')}:${shell.getAttribute('data-block-hash') || ''}`;
        }

        requestHeightWarmupBatch(generation) {
            const requests = [];
            const requestedBlockKeys = new Set();
            for (let index = this.heightWarmupCursor;
                index <= this.heightWarmupEndIndex
                    && index < this.contentRoot.children.length
                    && requests.length < MAX_BLOCK_HTML_BATCH_SIZE;
                index++) {
                const shell = this.contentRoot.children[index];
                const blockKey = this.virtualization.getBlockKey(shell);
                if (!blockKey
                    || requestedBlockKeys.has(blockKey)
                    || this.virtualization.getShellBlock(shell)
                    || this.virtualization.hasMeasuredHeight(shell, this.heightWarmupMeasurementWidth)
                    || this.heightWarmupFailedKeys.has(blockKey)) {
                    continue;
                }
                requestedBlockKeys.add(blockKey);
                const requestKey = this.getHeightWarmupRequestKey(shell);
                if (this.heightWarmupHtml.has(requestKey)) {continue;}

                const isCurrent = index === this.heightWarmupCursor;
                if (!isCurrent && shell.getAttribute('data-html-request-id')) {continue;}
                const request = this.registerVirtualBlockHtmlRequest(shell, {
                    measureOnly: true,
                    onHtml: html => {
                        if (generation !== this.heightWarmupGeneration) return;
                        this.heightWarmupHtml.set(requestKey, html);
                        const currentShell = this.contentRoot.children[this.heightWarmupCursor];
                        if (!this.heightWarmupBusy
                            && currentShell
                            && this.getHeightWarmupRequestKey(currentShell) === requestKey) {
                            void this.runHeightWarmupStep(generation);
                        }
                    }
                });
                if (request === undefined) {continue;}
                if (isCurrent && request === null) {return true;}
                if (request) {requests.push(request);}
            }
            if (requests.length > 0) {
                previewBridge.postMessage({
                    command: PreviewToHostCommand.RequestBlockHtml,
                    requests
                });
            }
            return requests.length > 0;
        }

        async runHeightWarmupStep(generation) {
            if (generation !== this.heightWarmupGeneration || !this.virtualization.isEnabled()) return;
            if (this.heightWarmupCursor === 0 && document.fonts?.status === 'loading') {
                await document.fonts.ready;
                if (generation !== this.heightWarmupGeneration) return;
            }

            if (!this.viewportAnchor.isPinned()) {
                this.viewportAnchor.pin(this.virtualization.getShells());
            }

            let shell = null;
            const measurementWidth = this.heightWarmupMeasurementWidth ?? this.virtualization.getMeasurementWidth();
            while (this.heightWarmupCursor <= this.heightWarmupEndIndex
                && this.heightWarmupCursor < this.contentRoot.children.length) {
                const candidate = this.contentRoot.children[this.heightWarmupCursor];
                const key = this.virtualization.getBlockKey(candidate);
                let height;
                if (key && this.virtualization.hasMeasuredHeight(candidate, measurementWidth)) {
                    height = this.virtualization.getCachedBlockHeight(key);
                } else if (this.virtualization.getShellBlock(candidate)) {
                    height = await this.stabilizeMountedBlockHeight(this.virtualization.getShellBlock(candidate));
                    if (generation !== this.heightWarmupGeneration) return;
                    if (height === undefined) {
                        if (!this.virtualization.getShellBlock(candidate) && key) {
                            shell = candidate;
                            break;
                        }
                        if (key) {this.heightWarmupFailedKeys.add(key);}
                        height = this.virtualization.getShellHeightBaseline(candidate);
                    }
                } else if (key && this.heightWarmupFailedKeys.has(key)) {
                    height = this.virtualization.getShellHeightBaseline(candidate);
                } else if (key) {
                    shell = candidate;
                    break;
                }
                if (this.acceptWarmupHeight(height ?? 0)) { return; }
            }
            if (!shell) {
                this.finishHeightWarmup();
                return;
            }
            if (this.heightWarmupBusy) return;

            const key = this.virtualization.getBlockKey(shell);
            const requestKey = this.getHeightWarmupRequestKey(shell);
            const measure = async html => {
                if (generation !== this.heightWarmupGeneration) return undefined;
                if (!html) return undefined;
                this.heightWarmupBusy = true;
                try {
                    return await this.virtualization.measureBlockHtml(
                        shell,
                        html,
                        block => this.prepareBlockHeightResources(block, true),
                        measurementWidth
                    );
                } catch (error) {
                    console.warn('[SnapTeX] Background block height measurement failed.', error);
                    return undefined;
                } finally {
                    this.heightWarmupBusy = false;
                    if (generation !== this.heightWarmupGeneration
                        && this.heightWarmupCursor !== null
                        && this.heightWarmupTimer === null) {
                        this.scheduleHeightWarmupStep(this.heightWarmupGeneration);
                    }
                }
            };
            const continueWarmup = measured => {
                if (generation !== this.heightWarmupGeneration) return;
                if (measured === undefined) { this.heightWarmupFailedKeys.add(key); }
                const height = measured ?? this.virtualization.getShellHeightBaseline(shell);
                if (!this.acceptWarmupHeight(height)) {
                    if (this.heightWarmupCursor % HEIGHT_WARMUP_BATCH_SIZE === 0) {
                        this.scheduleHeightWarmupStep(generation);
                    } else {
                        void this.runHeightWarmupStep(generation);
                    }
                }
            };
            const cachedHtml = this.virtualization.getBlockHtml(shell);
            if (cachedHtml) {
                continueWarmup(await measure(cachedHtml));
                return;
            }
            if (this.heightWarmupHtml.has(requestKey)) {
                const html = this.heightWarmupHtml.get(requestKey);
                this.heightWarmupHtml.delete(requestKey);
                continueWarmup(await measure(html));
                return;
            }
            if (!this.requestHeightWarmupBatch(generation)) {continueWarmup(undefined);}
        }

        acceptWarmupHeight(height) {
            const complete = this.pagination.acceptHeight(this.heightWarmupCursor, height);
            this.heightWarmupCursor += 1;
            if (complete) { this.finishHeightWarmup(); }
            return complete;
        }

        finishHeightWarmup() {
            this.invalidateHeightWarmup();
            this.heightWarmupCursor = null;
            this.heightWarmupEndIndex = null;
            this.heightWarmupMeasurementWidth = null;
            this.pagination.finishIncremental();
            this.refreshViewportAnchorAfterLayout();
        }

        waitForMeasurement(element, events, check, timeout = 30000) {
            if (!element.isConnected || check()) {
                return Promise.resolve(element.isConnected && check());
            }
            return new Promise(resolve => {
                const block = element.closest('.latex-block');
                const cleanup = () => {
                    clearTimeout(timer);
                    events.forEach(event => element.removeEventListener(event, finish));
                    block?.removeEventListener(HEIGHT_MEASUREMENT_CANCEL_EVENT, finish);
                };
                const finish = () => {
                    cleanup();
                    resolve(element.isConnected && check());
                };
                const timer = setTimeout(finish, timeout);
                events.forEach(event => element.addEventListener(event, finish, { once: true }));
                block?.addEventListener(HEIGHT_MEASUREMENT_CANCEL_EVENT, finish, { once: true });
            });
        }

        async prepareBlockHeightResources(block, measurementOnly) {
            if (measurementOnly) {this.fillCurrentNumbering(block);}

            const images = Array.from(block.querySelectorAll('img')).map(image => ({
                image,
                src: image.getAttribute('src'),
                srcset: image.getAttribute('srcset')
            }));
            if (measurementOnly) {
                images.forEach(({ image }) => {
                    image.removeAttribute('src');
                    image.removeAttribute('srcset');
                });
            }
            for (const { image, src, srcset } of images) {
                image.loading = 'eager';
                if (measurementOnly) {
                    if (srcset) { image.setAttribute('srcset', srcset); }
                    if (src) { image.setAttribute('src', src); }
                }
                const loaded = await this.waitForMeasurement(
                    image,
                    ['load', 'error'],
                    () => image.complete,
                    15000
                );
                if (!loaded || image.naturalWidth <= 0) return false;

                const rect = image.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return false;
                if (measurementOnly) {
                    image.style.width = `${Math.ceil(rect.width)}px`;
                    image.style.height = `${Math.ceil(rect.height)}px`;
                    image.removeAttribute('src');
                    image.removeAttribute('srcset');
                }
            }

            for (const canvas of block.querySelectorAll('canvas[data-req-path]')) {
                if (measurementOnly) {
                    canvas.id = `measure-pdf-${++this.measurementResourceSeq}`;
                    canvas.setAttribute('data-pdf-measure-only', 'true');
                }
                this.requestPdfCanvas(canvas);
                const rendered = await this.waitForMeasurement(
                    canvas,
                    ['snaptex-pdf-settled'],
                    () => canvas.getAttribute('data-rendered') === 'true'
                );
                if (!rendered) return false;
                if (canvas.getBoundingClientRect().height <= 0) return false;
                if (measurementOnly) {this.releasePdfCanvasBitmap(canvas);}
            }

            const tikzContainers = Array.from(block.querySelectorAll('.tikz-container'));
            if (tikzContainers.length > 0) {
                try {
                    await window.ensureTikzJaxLoaded();
                } catch {
                    return false;
                }
                for (const container of tikzContainers) {
                    window.watchPendingTikzContainers(block, [container]);
                    window.activatePendingTikzScripts(block, [container]);
                    await this.waitForTikzBatch([container]);
                    if (!hasRenderedTikz(container)) return false;

                    const height = Math.ceil(container.getBoundingClientRect().height);
                    if (height <= 0) return false;
                    if (measurementOnly) {
                        container.replaceChildren();
                        container.style.height = `${height}px`;
                    }
                }
            }
            return block.isConnected;
        }

        getPendingTikzContainers(root = document) {
            return Array.from(root.querySelectorAll('.tikz-container')).filter(container => {
                if (hasRenderedTikz(container) || container.getAttribute('data-tikz-state') === 'failed') return false;
                return !!container.querySelector(TIKZ_SCRIPT_SELECTOR);
            });
        }

        waitForTikzBatch(containers) {
            return Promise.all(containers.map(container => this.waitForMeasurement(
                container,
                ['snaptex-tikz-settled'],
                () => hasRenderedTikz(container) || container.getAttribute('data-tikz-state') === 'failed',
                TIKZ_BATCH_RENDER_TIMEOUT_MS
            )));
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
            if (this.initialExpansionFrame !== null) {
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

        onRenderComplete(savedScrollState, renderSeq) {
            if (renderSeq !== this.renderCompletionSeq) return;
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
            this.scheduleHeightWarmup();
        }

        onPatchComplete(savedScrollState, renderSeq) {
            if (renderSeq !== this.renderCompletionSeq) return;
            this.state = 'IDLE';
            if (this.pendingScroll) {
                this.executeScroll(this.pendingScroll);
                this.pendingScroll = null;
            } else {
                this.restoreScrollState(savedScrollState);
            }
        }

        getPatchPaginationRange(payload) {
            const dirtyIndices = Object.keys(payload.dirtyBlocks || {}).map(Number).filter(Number.isFinite);
            const firstChangedIndex = Math.min(payload.start, ...dirtyIndices);
            const insertedEnd = payload.start + Math.max(0, (payload.htmls?.length || 0) - 1);
            const paginationIndex = payload.deleteCount === 0 && (payload.htmls?.length || 0) > 0
                ? Math.min(firstChangedIndex, Math.max(0, payload.start - 1))
                : firstChangedIndex;
            return {
                startIndex: this.pagination.isEnabled()
                    ? this.pagination.getPageStartIndex(paginationIndex)
                    : paginationIndex,
                lastChangedIndex: Math.max(payload.start, insertedEnd, ...dirtyIndices)
            };
        }

        handleScrollCommand(data) {
            if (this.interactiveResizeActive) return;
            this.deferHeightWarmup();
            if (this.state === 'RENDERING' || this.isFirstLoad) { this.pendingScroll = data; }
            else { this.executeScroll(data); }
        }

        onScroll() {
            if (this.state !== 'IDLE' || this.interactiveResizeActive) return;
            const now = Date.now();
            if (now < this.previewLayoutSyncSuppressedUntil) return;
            if (now - this.lastScrollTime < this.config.autoScrollDelay) return;
            this.lastScrollTime = now;
            const blocks = this.contentRoot.children;
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
                    const sourceAnchor = Array.from(block.querySelectorAll('[data-sn-src-start]')).find(element => {
                        const anchorRect = element.getBoundingClientRect();
                        return anchorRect.top <= viewCenter && anchorRect.bottom >= viewCenter;
                    });
                    previewBridge.postMessage({
                        command: PreviewToHostCommand.SyncScroll,
                        index,
                        ratio,
                        sourceStart: sourceAnchor ? Number(sourceAnchor.getAttribute('data-sn-src-start')) : undefined,
                        sourceEnd: sourceAnchor ? Number(sourceAnchor.getAttribute('data-sn-src-end')) : undefined
                    });
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
            if (window.scrollY <= 1) {
                return { scrollY: 0 };
            }

            const blocks = this.contentRoot.children;
            for (const block of blocks) {
                const rect = block.getBoundingClientRect();
                if (rect.bottom > 0 && rect.top < window.innerHeight) {
                    return { index: block.getAttribute('data-index'), ratio: -rect.top / rect.height };
                }
            }
            return null;
        }

        restoreScrollState(state) {
            if (!state) return;
            let targetY = typeof state.scrollY === 'number' ? state.scrollY : null;
            if (targetY === null && state.index) {
                const block = this.getBlockOrShellByIndex(state.index);
                if (!block) return;
                const newTop = block.getBoundingClientRect().top + window.scrollY;
                targetY = state.ratio >= 0 ? newTop + (block.offsetHeight * state.ratio) : newTop;
            }
            if (targetY === null || Math.abs(window.scrollY - targetY) < 1) return;
            this.lockScrolling(500);
            window.scrollTo({ top: targetY, behavior: 'auto' });
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

            const shell = this.virtualization.findMatchingShell(index);
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

        smartFullUpdate(htmls, preserveUnchangedBlocks = true) {
            const newElements = htmls
                .map(html => parseFirstElementFromHtml(html))
                .filter(Boolean);
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
                const oldHash = oldEl.getAttribute('data-block-hash');
                const newHash = newEl.getAttribute('data-block-hash');
                if (!preserveUnchangedBlocks || !oldHash || !newHash || oldHash !== newHash) {
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
            const previousSibling = start > 0 ? this.contentRoot.children[start - 1] : null;
            const staleTikzByIndex = new Map();
            const removedBlocks = [];

            for (let i = 0; i < deleteCount; i++) {
                const block = this.contentRoot.children[start];
                if (!block) break;
                removedBlocks.push(block);
                this.rememberStaleTikzPreviews(block, staleTikzByIndex);
                block.remove();
            }
            const insertedBlocks = htmls.map(html => parseFirstElementFromHtml(html)).filter(Boolean);
            this.insertElementsBefore(insertedBlocks, referenceNode);
            this.pagination.transferPatchLayout(removedBlocks, insertedBlocks, previousSibling, referenceNode);
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
            const previousSibling = start > 0 ? this.contentRoot.children[start - 1] : null;
            const staleTikzByIndex = new Map();
            const removedShells = [];

            for (let i = 0; i < deleteCount; i++) {
                const shell = this.contentRoot.children[start];
                if (!shell) break;
                removedShells.push(shell);
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
            this.pagination.transferPatchLayout(removedShells, insertedShells, previousSibling, referenceNode);

            if (shift !== 0) {
                this.virtualization.remapShellIndicesFromDomPosition(start + insertedShells.length, shift);
            }

            this.forEachDirtyBlock(payload, (idx, html) => {
                const shell = this.virtualization.findMatchingShell(idx);
                const replacement = shell ? parseFirstElementFromHtml(html) : null;
                if (!replacement) return;

                const previews = this.collectTikzPreviews(shell);
                this.heightWarmupFailedKeys.delete(this.virtualization.getBlockKey(shell));
                this.virtualization.forgetBlockHeight(shell);
                const newShell = this.virtualization.createShellForBlock(replacement);
                this.stashStaleTikzPreviewsOnShell(newShell, previews);
                this.virtualization.unobserveShell(shell);
                shell.replaceWith(newShell);
                this.pagination.transferPatchLayout([shell], [newShell]);
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
                this.fillBlockNumbering(blockEl, counts);
            }
            this.fillReferences(document, labels);
        }

        fillCurrentNumbering(block) {
            if (!this.currentNumbering) return;
            const index = block.getAttribute('data-index');
            this.fillBlockNumbering(block, this.currentNumbering.blocks?.[index]);
            this.fillReferences(block, this.currentNumbering.labels);
        }

        fillBlockNumbering(block, counts) {
            if (!counts) return;
            for (const [type, values] of Object.entries(counts)) {
                if (!Array.isArray(values) || values.length === 0) continue;
                block.querySelectorAll(`.sn-cnt[data-type="${type}"]`)
                    .forEach((span, index) => { if (values[index]) span.textContent = values[index]; });
            }
        }

        fillReferences(root, labels) {
            if (!labels) return;
            root.querySelectorAll('.sn-ref').forEach(ref => {
                const key = ref.getAttribute('data-key');
                ref.textContent = key && labels[key] ? labels[key] : '??';
            });
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
            if (this.pdfRenderTimer !== null) clearTimeout(this.pdfRenderTimer);

            let timeout;
            const run = () => {
                if (this.pdfRenderTimer !== timeout) return;
                if (this.pdfRenderTimer !== null) {
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


