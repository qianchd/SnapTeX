// @ts-nocheck
/* eslint-disable curly */

import { PREVIEW_RESIZE_ACTIVE_CLASS } from './viewport';

const BLOCK_VIRTUALIZATION_INITIAL_PRELOAD_MARGIN_VH = 120;
const BLOCK_VIRTUALIZATION_BASE_PRELOAD_MARGIN_VH = 250;
const BLOCK_VIRTUALIZATION_RETAIN_MARGIN_VH = 400;
export const BLOCK_VIRTUALIZATION_CLEANUP_DELAY_MS = 700;
export const HEIGHT_MEASUREMENT_CANCEL_EVENT = 'snaptex-height-measurement-cancelled';
const BLOCK_VIRTUALIZATION_DEFAULT_HEIGHT = 180;
const HEIGHT_CACHE_WIDTH_TOLERANCE = 0.005;

export function viewportHeightToPixels(valueInVh) {
    return Math.max(0, Math.round(window.innerHeight * valueInVh / 100));
}

export function parseFirstElementFromHtml(html) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    return tempDiv.firstElementChild;
}

export function isElementWithinViewportMargins(element, margins) {
    const rect = element.getBoundingClientRect();
    const above = typeof margins === 'number' ? margins : margins.above;
    const below = typeof margins === 'number' ? margins : margins.below;
    return rect.bottom >= -above && rect.top <= window.innerHeight + below;
}

/**
 * Maintains lightweight shells for offscreen LaTeX blocks.
 *
 * The controller caches block HTML and measured heights so large previews keep
 * stable scroll geometry while only nearby blocks stay mounted in the DOM.
 */
export class BlockVirtualizationController {
        constructor(contentRoot, viewportAnchor) {
            this.contentRoot = contentRoot;
            this.viewportAnchor = viewportAnchor;
            this.enabled = false;
            this.fontSize = 16;
            this.heightCache = new Map();
            this.htmlCache = new Map();
            this.measurementHost = null;
            this.observedShells = new Set();
            this.resizeObserver = typeof ResizeObserver !== 'undefined'
                ? new ResizeObserver(entries => this.onShellResize(entries))
                : null;
        }

        setEnabled(enabled) {
            this.enabled = enabled === true;
        }

        isEnabled() {
            return this.enabled;
        }

        setFontSize(value) {
            const previous = this.fontSize;
            this.fontSize = parseFloat(value) || previous;
            return this.fontSize / previous;
        }

        resetHeightCache() {
            this.heightCache.clear();
            this.cancelHeightMeasurement();
        }

        resetCaches() {
            this.resetHeightCache();
            this.htmlCache.clear();
        }

        cancelHeightMeasurement() {
            this.measurementHost?.querySelector('.latex-block')
                ?.dispatchEvent(new Event(HEIGHT_MEASUREMENT_CANCEL_EVENT));
            this.measurementHost?.remove();
            this.measurementHost = null;
        }

        getBlockKey(element) {
            if (!element) return '';
            return element.getAttribute('data-block-hash') || element.getAttribute('data-index') || '';
        }

        getBlockIndex(element) {
            return element ? element.getAttribute('data-index') : null;
        }

        estimateBlockHeightFromHtml(html) {
            const lineBreaks = (html.match(/<br\b|\n|<\/p>|<\/div>|<\/li>/g) || []).length;
            const byLength = Math.ceil(html.length / 36);
            return Math.max(BLOCK_VIRTUALIZATION_DEFAULT_HEIGHT, Math.min(1400, (lineBreaks + byLength) * 10));
        }

        estimateBlockHeightFromMeta(meta) {
            const lineCount = typeof meta.lineCount === 'number' ? meta.lineCount : 1;
            return Math.max(BLOCK_VIRTUALIZATION_DEFAULT_HEIGHT, Math.min(1400, lineCount * 28));
        }

        getMeasurementWidth(style = getComputedStyle(this.contentRoot)) {
            const horizontalPadding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
            return Math.max(1, this.contentRoot.clientWidth - horizontalPadding);
        }

        cacheBlockHeight(key, height, fontSize = this.fontSize, measurementWidth = this.getMeasurementWidth(), settled = false) {
            if (key && Number.isFinite(height) && height >= 0) {
                this.heightCache.set(key, {
                    heightEm: height / fontSize,
                    widthEm: measurementWidth / fontSize,
                    settled
                });
            }
        }

        getCachedBlockHeight(key) {
            const cached = key ? this.heightCache.get(key) : undefined;
            return cached === undefined ? undefined : cached.heightEm * this.fontSize;
        }

        hasMeasuredHeight(element, measurementWidth = this.getMeasurementWidth()) {
            const cached = this.heightCache.get(this.getBlockKey(element));
            if (!cached?.settled) return false;
            const widthEm = measurementWidth / this.fontSize;
            return Math.abs(cached.widthEm - widthEm) / Math.max(cached.widthEm, widthEm) < HEIGHT_CACHE_WIDTH_TOLERANCE;
        }

        forgetBlockHeight(element) {
            this.heightCache.delete(this.getBlockKey(element));
        }

        rememberBlockHeight(block) {
            if (!block) return;

            const key = this.getBlockKey(block);
            if (!key) return;

            const rect = block.getBoundingClientRect();
            const settled = this.hasMeasuredHeight(block);
            this.cacheBlockHeight(key, Math.ceil(rect.height), this.fontSize, this.getMeasurementWidth(), settled);
        }

        getAnchorIdsFromBlock(block) {
            if (!block) return [];
            const anchors = new Set();
            if (block.id) { anchors.add(block.id); }
            block.querySelectorAll('[id]').forEach(element => anchors.add(element.id));
            return Array.from(anchors);
        }

        setShellAnchors(shell, anchors) {
            shell._snaptexAnchorIds = Array.isArray(anchors) ? anchors : [];
        }

        getShellAnchors(shell) {
            return Array.isArray(shell?._snaptexAnchorIds) ? shell._snaptexAnchorIds : [];
        }

        findShellByAnchorId(anchorId) {
            if (!anchorId) return null;
            return this.getShells().find(shell => this.getShellAnchors(shell).includes(anchorId)) || null;
        }

        getShellHeightBaseline(shell) {
            const rect = shell.getBoundingClientRect();
            if (rect.height > 0) return rect.height;
            const explicitHeight = parseFloat(shell.style.height || shell.style.minHeight || '');
            return Number.isFinite(explicitHeight) ? explicitHeight : BLOCK_VIRTUALIZATION_DEFAULT_HEIGHT;
        }

        lockShellHeight(shell, height) {
            const safeHeight = Math.max(0, Math.ceil(height ?? this.getShellHeightBaseline(shell)));
            const normalizedHeight = safeHeight / this.fontSize;
            shell.style.height = `${normalizedHeight}em`;
            shell.style.minHeight = `${normalizedHeight}em`;
            shell.style.overflow = 'hidden';
        }

        unlockShellHeight(shell) {
            shell.style.height = '';
            shell.style.minHeight = '';
            shell.style.overflow = '';
        }

        measureMountedBlockHeight(shell) {
            const block = this.getShellBlock(shell);
            if (!block) return this.getShellHeightBaseline(shell);
            return Math.ceil(Math.max(block.getBoundingClientRect().height, block.scrollHeight));
        }

        isShellAboveViewport(shell) {
            return shell.getBoundingClientRect().bottom <= 0;
        }

        wasShellAboveViewport(shell, previousHeight) {
            return shell.getBoundingClientRect().top + previousHeight <= 0;
        }

        withViewportAnchorPreserved(callback, shells) {
            return this.viewportAnchor.preserve(shells || this.getShells(), callback);
        }

        refreshMountedShellHeight(shell, settled = false) {
            if (!this.getShellBlock(shell)) return undefined;

            const height = this.measureMountedBlockHeight(shell);
            const key = this.getBlockKey(shell);
            this.cacheBlockHeight(key, height, this.fontSize, this.getMeasurementWidth(), settled);
            if (this.isShellAboveViewport(shell)) {
                this.lockShellHeight(shell, height);
            } else {
                this.unlockShellHeight(shell);
            }
            return height;
        }

        settleMountedShellHeight(shell) {
            if (!this.getShellBlock(shell)) return undefined;
            delete shell._snaptexReservedHeight;
            this.unlockShellHeight(shell);
            return this.refreshMountedShellHeight(shell, true);
        }

        observeShell(shell) {
            if (!shell || !this.resizeObserver || this.observedShells.has(shell)) return;
            this.observedShells.add(shell);
            this.resizeObserver.observe(shell);
        }

        unobserveShell(shell) {
            if (!shell || !this.resizeObserver || !this.observedShells.has(shell)) return;
            this.resizeObserver.unobserve(shell);
            this.observedShells.delete(shell);
        }

        disconnectShellObservers() {
            if (!this.resizeObserver) return;
            this.resizeObserver.disconnect();
            this.observedShells.clear();
        }

        onShellResize(entries) {
            if (document.body.classList.contains(PREVIEW_RESIZE_ACTIVE_CLASS)
                || this.contentRoot.getBoundingClientRect().width <= 0) return;
            let scrollDelta = 0;
            const preserveViewport = !this.viewportAnchor.isPinned();
            const measurementWidth = this.getMeasurementWidth();
            entries.forEach(entry => {
                const shell = entry.target;
                if (Number.isFinite(shell._snaptexReservedHeight)) return;
                const nextHeight = this.measureMountedBlockHeight(shell);
                const key = this.getBlockKey(shell);
                const previousHeight = this.getCachedBlockHeight(key);
                const settled = this.hasMeasuredHeight(shell, measurementWidth);
                if (preserveViewport
                    && previousHeight !== undefined
                    && this.wasShellAboveViewport(shell, previousHeight)) {
                    scrollDelta += nextHeight - previousHeight;
                }
                this.cacheBlockHeight(key, nextHeight, this.fontSize, measurementWidth, settled);
            });
            if (Math.abs(scrollDelta) >= 1 && window.scrollY > 0) {
                window.scrollBy(0, scrollDelta);
            }
        }

        createShell(index, hash, height, anchors) {
            const shell = document.createElement('div');
            shell.className = 'latex-block-shell';
            if (index !== null && index !== undefined) { shell.setAttribute('data-index', String(index)); }
            if (hash) { shell.setAttribute('data-block-hash', hash); }
            shell.setAttribute('data-mounted', 'false');
            this.lockShellHeight(shell, height);
            this.setShellAnchors(shell, anchors);
            return shell;
        }

        createShellForBlock(block) {
            const index = this.getBlockIndex(block);
            const hash = block.getAttribute('data-block-hash') || '';
            const key = this.getBlockKey(block);
            const html = block.outerHTML;

            this.htmlCache.set(key || index, html);
            return this.createShell(index, hash, this.getCachedBlockHeight(key) ?? this.estimateBlockHeightFromHtml(html), this.getAnchorIdsFromBlock(block));
        }

        createShellForMeta(meta) {
            return this.createShell(meta.index, meta.hash, this.getCachedBlockHeight(meta.hash) ?? this.estimateBlockHeightFromMeta(meta), meta.anchors);
        }

        pruneCaches(activeKeys) {
            const active = new Set(activeKeys.filter(Boolean).map(key => String(key)));
            const prune = cache => {
                for (const key of cache.keys()) {
                    if (!active.has(String(key))) {
                        cache.delete(key);
                    }
                }
            };
            prune(this.heightCache);
            prune(this.htmlCache);
        }

        pruneCachesFromContent() {
            const activeKeys = Array.from(this.contentRoot.children)
                .map(element => this.getBlockKey(element));
            this.pruneCaches(activeKeys);
        }

        getCacheStats() {
            let htmlChars = 0;
            for (const html of this.htmlCache.values()) {
                htmlChars += html.length;
            }
            return {
                heightCacheEntries: this.heightCache.size,
                htmlCacheEntries: this.htmlCache.size,
                htmlCacheChars: htmlChars
            };
        }

        getShells() {
            const shells = [];
            for (let index = 0; index < this.contentRoot.children.length; index++) {
                const element = this.contentRoot.children[index];
                if (element.classList.contains('latex-block-shell')) { shells.push(element); }
            }
            return shells;
        }

        getShellBlock(shell) {
            return shell ? shell.querySelector(':scope > .latex-block') : null;
        }

        getMountMargin(phase = 'normal') {
            return phase === 'initial'
                ? viewportHeightToPixels(BLOCK_VIRTUALIZATION_INITIAL_PRELOAD_MARGIN_VH)
                : viewportHeightToPixels(BLOCK_VIRTUALIZATION_BASE_PRELOAD_MARGIN_VH);
        }

        isShellInMountRange(shell, phase = 'normal') {
            return isElementWithinViewportMargins(shell, this.getMountMargin(phase));
        }

        mountShell(shell, onMissingHtml) {
            if (!this.enabled || this.getShellBlock(shell)) return null;

            const key = this.getBlockKey(shell);
            const html = this.getBlockHtml(shell);
            if (!html) {
                if (onMissingHtml) { onMissingHtml(shell); }
                return null;
            }

            const block = parseFirstElementFromHtml(html);
            if (!block) return null;

            const reservedHeight = this.getShellHeightBaseline(shell);
            const preserveMeasuredHeight = this.hasMeasuredHeight(shell);
            shell.textContent = '';
            shell.appendChild(block);
            if (this.isShellAboveViewport(shell)) {
                this.lockShellHeight(shell, reservedHeight);
                if (preserveMeasuredHeight) {shell._snaptexReservedHeight = reservedHeight;}
            } else if (preserveMeasuredHeight) {
                this.unlockShellHeight(shell);
                shell.style.minHeight = `${reservedHeight / this.fontSize}em`;
                shell._snaptexReservedHeight = reservedHeight;
            } else {
                this.unlockShellHeight(shell);
            }
            shell.setAttribute('data-mounted', 'true');
            this.setShellAnchors(shell, this.getAnchorIdsFromBlock(block));
            this.observeShell(shell);
            if (!preserveMeasuredHeight) {this.refreshMountedShellHeight(shell);}
            return block;
        }

        unmountShell(shell) {
            const block = this.getShellBlock(shell);
            if (!block) return;

            const key = this.getBlockKey(block);
            const reservedHeight = shell._snaptexReservedHeight;
            if (!Number.isFinite(reservedHeight)) {this.rememberBlockHeight(block);}
            const height = Number.isFinite(reservedHeight)
                ? reservedHeight
                : this.getCachedBlockHeight(key) ?? Math.ceil(block.getBoundingClientRect().height);
            delete shell._snaptexReservedHeight;
            block.dispatchEvent(new Event(HEIGHT_MEASUREMENT_CANCEL_EVENT));
            block.remove();
            this.lockShellHeight(shell, height);
            shell.setAttribute('data-mounted', 'false');
            this.unobserveShell(shell);
        }

        updateMountedShells(onMount, onMissingHtml, options = {}) {
            if (!this.enabled || this.contentRoot.getBoundingClientRect().width <= 0) return [];

            const shells = this.getShells();
            const update = () => {
                const mounted = [];
                const phase = options.phase || 'normal';
                const allowUnmount = options.allowUnmount !== false;
                const mountMargin = this.getMountMargin(phase);
                const retainMargin = viewportHeightToPixels(BLOCK_VIRTUALIZATION_RETAIN_MARGIN_VH);
                shells.forEach(shell => {
                    const rect = shell.getBoundingClientRect();
                    const inMountRange = rect.bottom >= -mountMargin && rect.top <= window.innerHeight + mountMargin;
                    const inRetainRange = rect.bottom >= -retainMargin && rect.top <= window.innerHeight + retainMargin;
                    let block = this.getShellBlock(shell);
                    if (inMountRange) {
                        if (!block) {
                            block = this.mountShell(shell, onMissingHtml);
                            if (block) {
                                mounted.push(block);
                                if (onMount) { onMount(block); }
                            }
                        }
                    } else if (allowUnmount && block && !inRetainRange) {
                        this.unmountShell(shell);
                        block = null;
                    }
                    if (!options.pruneHtmlCache || block || shell.getAttribute('data-html-request-id') || inRetainRange) return;

                    const key = this.getBlockKey(shell);
                    const index = this.getBlockIndex(shell);
                    if (key) { this.htmlCache.delete(key); }
                    if (index && index !== key) { this.htmlCache.delete(index); }
                });
                return mounted;
            };
            return options.preserveViewportAnchor === false
                ? update()
                : this.withViewportAnchorPreserved(update, shells);
        }

        replaceContentWithShellElements(shells, onMount, onMissingHtml, options = {}) {
            const fragment = document.createDocumentFragment();
            shells.forEach(shell => fragment.appendChild(shell));
            this.pruneCaches(shells.map(shell => this.getBlockKey(shell)));
            this.disconnectShellObservers();
            this.contentRoot.replaceChildren(fragment);
            this.updateMountedShells(onMount, onMissingHtml, options);
        }

        replaceContentWithShells(blocks, onMount) {
            this.replaceContentWithShellElements(
                blocks.map(block => this.createShellForBlock(block)),
                onMount
            );
        }

        replaceContentWithBlockMetadata(blocks, onMount, onMissingHtml, options = {}) {
            this.replaceContentWithShellElements(
                blocks.map(meta => this.createShellForMeta(meta)),
                onMount,
                onMissingHtml,
                options
            );
        }

        storeBlockHtml(index, hash, html) {
            const key = hash || String(index);
            const shell = this.findMatchingShell(index, hash);
            if (!shell) return null;

            this.htmlCache.set(key, html);
            return shell;
        }

        findMatchingShell(index, hash) {
            const shell = this.contentRoot.querySelector(`.latex-block-shell[data-index="${index}"]`);
            const shellHash = shell?.getAttribute('data-block-hash') || '';
            return shell && (!hash || !shellHash || shellHash === hash) ? shell : null;
        }

        getBlockHtml(shell) {
            return this.htmlCache.get(this.getBlockKey(shell))
                || this.htmlCache.get(this.getBlockIndex(shell));
        }

        ensureMeasurementHost(measurementWidth) {
            if (!this.measurementHost?.isConnected) {
                const style = getComputedStyle(this.contentRoot);
                this.measurementHost = document.createElement('div');
                (this.contentRoot.parentElement ?? document.body).appendChild(this.measurementHost);
                Object.assign(this.measurementHost.style, {
                    position: 'fixed',
                    left: '-100000px',
                    top: '0',
                    width: `${measurementWidth ?? this.getMeasurementWidth(style)}px`,
                    visibility: 'hidden',
                    pointerEvents: 'none',
                    contain: 'layout style paint',
                    height: 'auto',
                    overflow: 'visible',
                    font: style.font,
                    fontSize: style.fontSize,
                    lineHeight: style.lineHeight,
                    letterSpacing: style.letterSpacing,
                    wordSpacing: style.wordSpacing,
                    textAlign: style.textAlign
                });
            }
            return this.measurementHost;
        }

        async measureBlockHtml(shell, html, prepareBlock, measurementWidth) {
            if (!shell?.isConnected) return undefined;
            if (this.getShellBlock(shell)) return this.refreshMountedShellHeight(shell);

            const block = parseFirstElementFromHtml(html);
            if (!block) return undefined;

            const host = this.ensureMeasurementHost(measurementWidth);
            const measurementShell = document.createElement('div');
            measurementShell.className = 'latex-block-shell';
            measurementShell.setAttribute('data-mounted', 'true');
            measurementShell.appendChild(block);
            host.replaceChildren(measurementShell);

            try {
                if (prepareBlock && await prepareBlock(block) === false) return undefined;
                if (!host.isConnected || measurementShell.parentElement !== host) return undefined;
                const height = Math.ceil(Math.max(measurementShell.getBoundingClientRect().height, measurementShell.scrollHeight));
                if (!shell.isConnected || this.getBlockKey(shell) !== this.getBlockKey(block)) return undefined;
                const key = this.getBlockKey(shell);
                this.cacheBlockHeight(
                    key,
                    height,
                    parseFloat(host.style.fontSize) || this.fontSize,
                    parseFloat(host.style.width) || this.getMeasurementWidth(),
                    true
                );
                this.withViewportAnchorPreserved(() => this.lockShellHeight(shell, height));
                return height;
            } finally {
                host.replaceChildren();
            }
        }

        remapShellIndicesFromDomPosition(startDomIndex, delta) {
            if (delta === 0) return;
            this.getShells().slice(startDomIndex).forEach(shell => {
                const oldIdx = parseInt(shell.getAttribute('data-index'));
                if (!isNaN(oldIdx)) {
                    shell.setAttribute('data-index', oldIdx + delta);
                    const block = this.getShellBlock(shell);
                    if (block) { block.setAttribute('data-index', oldIdx + delta); }
                }
            });
        }
    }
