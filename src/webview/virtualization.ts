// @ts-nocheck
/* eslint-disable curly */

const BLOCK_VIRTUALIZATION_INITIAL_PRELOAD_MARGIN_VH = 120;
const BLOCK_VIRTUALIZATION_BASE_PRELOAD_MARGIN_VH = 250;
const BLOCK_VIRTUALIZATION_RETAIN_MARGIN_VH = 400;
export const BLOCK_VIRTUALIZATION_CLEANUP_DELAY_MS = 700;
const BLOCK_VIRTUALIZATION_DEFAULT_HEIGHT = 180;

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
        constructor(contentRoot) {
            this.contentRoot = contentRoot;
            this.enabled = false;
            this.heightCache = new Map();
            this.htmlCache = new Map();
            this.observedShells = new Set();
            this.viewportAnchorPreserveDepth = 0;
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

        resetCaches() {
            this.heightCache.clear();
            this.htmlCache.clear();
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

        rememberBlockHeight(block) {
            if (!block) return;

            const key = this.getBlockKey(block);
            if (!key) return;

            const rect = block.getBoundingClientRect();
            if (rect.height > 0) {
                this.heightCache.set(key, Math.ceil(rect.height));
            }
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
            return parseFloat(shell.style.height || shell.style.minHeight || '') || BLOCK_VIRTUALIZATION_DEFAULT_HEIGHT;
        }

        lockShellHeight(shell, height) {
            const safeHeight = Math.max(1, Math.ceil(height || this.getShellHeightBaseline(shell)));
            shell.style.height = `${safeHeight}px`;
            shell.style.minHeight = `${safeHeight}px`;
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
            return Math.ceil(block.getBoundingClientRect().height || block.scrollHeight || this.getShellHeightBaseline(shell));
        }

        isShellAboveViewport(shell) {
            return shell.getBoundingClientRect().bottom <= 0;
        }

        wasShellAboveViewport(shell, previousHeight) {
            return shell.getBoundingClientRect().top + previousHeight <= 0;
        }

        captureViewportAnchor(shells = this.getShells()) {
            if (window.scrollY <= 0) return null;

            let anchor = null;
            let bestDistance = Infinity;
            shells.forEach(shell => {
                const rect = shell.getBoundingClientRect();
                if (rect.bottom <= 0 || rect.top >= window.innerHeight) return;

                const distance = rect.top <= 0 ? 0 : rect.top;
                if (distance < bestDistance) {
                    bestDistance = distance;
                    anchor = { element: shell, top: rect.top };
                }
            });
            return anchor;
        }

        restoreViewportAnchor(anchor) {
            if (!anchor?.element?.isConnected) return;

            const delta = anchor.element.getBoundingClientRect().top - anchor.top;
            if (Math.abs(delta) >= 1) {
                window.scrollBy(0, delta);
            }
        }

        withViewportAnchorPreserved(callback, shells) {
            if (this.viewportAnchorPreserveDepth > 0) {
                return callback();
            }

            const anchor = this.captureViewportAnchor(shells);
            this.viewportAnchorPreserveDepth += 1;
            try {
                const result = callback();
                this.restoreViewportAnchor(anchor);
                return result;
            } finally {
                this.viewportAnchorPreserveDepth -= 1;
            }
        }

        refreshMountedShellHeight(shell) {
            if (!this.getShellBlock(shell)) return;

            const height = this.measureMountedBlockHeight(shell);
            const key = this.getBlockKey(shell);
            if (key && height > 0) {
                this.heightCache.set(key, height);
            }
            if (this.isShellAboveViewport(shell)) {
                this.lockShellHeight(shell, height);
            } else {
                this.unlockShellHeight(shell);
            }
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
            let scrollDelta = 0;
            entries.forEach(entry => {
                const shell = entry.target;
                const nextHeight = Math.ceil(entry.contentRect.height);
                const key = this.getBlockKey(shell);
                const previousHeight = key ? this.heightCache.get(key) : undefined;
                if (previousHeight && nextHeight > 0 && this.wasShellAboveViewport(shell, previousHeight)) {
                    scrollDelta += nextHeight - previousHeight;
                }
                if (key && nextHeight > 0) {
                    this.heightCache.set(key, nextHeight);
                }
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
            return this.createShell(index, hash, this.heightCache.get(key) || this.estimateBlockHeightFromHtml(html), this.getAnchorIdsFromBlock(block));
        }

        createShellForMeta(meta) {
            return this.createShell(meta.index, meta.hash, this.heightCache.get(meta.hash) || this.estimateBlockHeightFromMeta(meta), meta.anchors);
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
            return Array.from(this.contentRoot.querySelectorAll('.latex-block-shell'));
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

        isShellInRetainRange(shell) {
            return isElementWithinViewportMargins(shell, viewportHeightToPixels(BLOCK_VIRTUALIZATION_RETAIN_MARGIN_VH));
        }

        pruneHtmlCacheOutsideRetainRange(shells = this.getShells()) {
            shells.forEach(shell => {
                if (this.getShellBlock(shell) || shell.getAttribute('data-html-request-id') || this.isShellInRetainRange(shell)) return;

                const key = this.getBlockKey(shell);
                const index = this.getBlockIndex(shell);
                if (key) { this.htmlCache.delete(key); }
                if (index && index !== key) { this.htmlCache.delete(index); }
            });
        }

        mountShell(shell, onMissingHtml) {
            if (!this.enabled || this.getShellBlock(shell)) return null;

            const key = this.getBlockKey(shell);
            const html = this.htmlCache.get(key) || this.htmlCache.get(this.getBlockIndex(shell));
            if (!html) {
                if (onMissingHtml) { onMissingHtml(shell); }
                return null;
            }

            const block = parseFirstElementFromHtml(html);
            if (!block) return null;

            const reservedHeight = this.getShellHeightBaseline(shell);
            shell.textContent = '';
            shell.appendChild(block);
            if (this.isShellAboveViewport(shell)) {
                this.lockShellHeight(shell, reservedHeight);
            } else {
                this.unlockShellHeight(shell);
            }
            shell.setAttribute('data-mounted', 'true');
            this.setShellAnchors(shell, this.getAnchorIdsFromBlock(block));
            this.observeShell(shell);
            this.refreshMountedShellHeight(shell);
            return block;
        }

        unmountShell(shell) {
            const block = this.getShellBlock(shell);
            if (!block) return;

            this.rememberBlockHeight(block);
            const key = this.getBlockKey(block);
            const height = this.heightCache.get(key) || Math.ceil(block.getBoundingClientRect().height) || BLOCK_VIRTUALIZATION_DEFAULT_HEIGHT;
            block.remove();
            this.lockShellHeight(shell, height);
            shell.setAttribute('data-mounted', 'false');
            this.unobserveShell(shell);
        }

        updateMountedShells(onMount, onMissingHtml, options = {}) {
            if (!this.enabled) return [];

            const shells = this.getShells();
            return this.withViewportAnchorPreserved(() => {
                const mounted = [];
                const phase = options.phase || 'normal';
                const allowUnmount = options.allowUnmount !== false;
                shells.forEach(shell => {
                    if (this.isShellInMountRange(shell, phase)) {
                        const block = this.mountShell(shell, onMissingHtml);
                        if (block) {
                            mounted.push(block);
                            if (onMount) { onMount(block); }
                        } else {
                            this.refreshMountedShellHeight(shell);
                        }
                    } else if (allowUnmount && this.getShellBlock(shell) && !this.isShellInRetainRange(shell)) {
                        this.unmountShell(shell);
                    }
                });
                if (options.pruneHtmlCache) {
                    this.pruneHtmlCacheOutsideRetainRange(shells);
                }
                return mounted;
            }, shells);
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
            const shell = this.contentRoot.querySelector(`.latex-block-shell[data-index="${index}"]`);
            if (!shell) return null;
            const shellHash = shell.getAttribute('data-block-hash') || '';
            if (hash && shellHash && shellHash !== hash) return null;

            this.htmlCache.set(key, html);
            return shell;
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
