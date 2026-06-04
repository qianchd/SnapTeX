"use strict";
var SnapTeXWebview = (() => {
  // src/webview/scheduler.ts
  var CoalescingTaskScheduler = class {
    constructor({ debounceMs, run, onError }) {
      this.debounceMs = debounceMs;
      this.run = run;
      this.onError = onError || (() => {
      });
      this.timer = null;
      this.pending = false;
      this.running = false;
    }
    request() {
      this.pending = true;
      if (this.running) return;
      this.schedule();
    }
    schedule() {
      if (this.timer) {
        clearTimeout(this.timer);
      }
      this.timer = setTimeout(() => this.flush(), this.debounceMs);
    }
    async flush() {
      this.timer = null;
      if (!this.pending || this.running) return;
      this.pending = false;
      this.running = true;
      try {
        await this.run();
      } catch (error) {
        this.onError(error);
      } finally {
        this.running = false;
        if (this.pending) {
          this.schedule();
        }
      }
    }
  };

  // src/webview/virtualization.ts
  var BLOCK_VIRTUALIZATION_BASE_PRELOAD_MARGIN = 5200;
  var BLOCK_VIRTUALIZATION_DIRECTIONAL_PRELOAD_MARGIN = 5200;
  var BLOCK_VIRTUALIZATION_RETAIN_MARGIN = 14e3;
  var BLOCK_VIRTUALIZATION_CLEANUP_DELAY_MS = 700;
  var BLOCK_VIRTUALIZATION_DEFAULT_HEIGHT = 180;
  var BlockVirtualizationController = class {
    constructor(contentRoot) {
      this.contentRoot = contentRoot;
      this.enabled = false;
      this.heightCache = /* @__PURE__ */ new Map();
      this.htmlCache = /* @__PURE__ */ new Map();
      this.observedShells = /* @__PURE__ */ new Set();
      this.resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver((entries) => this.onShellResize(entries)) : null;
    }
    setEnabled(enabled) {
      this.enabled = enabled === true;
    }
    isEnabled() {
      return this.enabled;
    }
    getBlockKey(element) {
      if (!element) return "";
      return element.getAttribute("data-block-hash") || element.getAttribute("data-index") || "";
    }
    getBlockIndex(element) {
      if (!element) return null;
      return element.getAttribute("data-index");
    }
    estimateBlockHeightFromHtml(html) {
      const lineBreaks = (html.match(/<br\b|\n|<\/p>|<\/div>|<\/li>/g) || []).length;
      const byLength = Math.ceil(html.length / 36);
      return Math.max(BLOCK_VIRTUALIZATION_DEFAULT_HEIGHT, Math.min(1400, (lineBreaks + byLength) * 10));
    }
    estimateBlockHeightFromMeta(meta) {
      const lineCount = typeof meta.lineCount === "number" ? meta.lineCount : 1;
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
    parseBlockHtml(html) {
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = html;
      return tempDiv.firstElementChild;
    }
    getAnchorIdsFromBlock(block) {
      if (!block) return [];
      const anchors = /* @__PURE__ */ new Set();
      if (block.id) {
        anchors.add(block.id);
      }
      block.querySelectorAll("[id]").forEach((element) => anchors.add(element.id));
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
      return this.getShells().find((shell) => this.getShellAnchors(shell).includes(anchorId)) || null;
    }
    getShellHeightBaseline(shell) {
      const rect = shell.getBoundingClientRect();
      if (rect.height > 0) return rect.height;
      return parseFloat(shell.style.height || shell.style.minHeight || "") || BLOCK_VIRTUALIZATION_DEFAULT_HEIGHT;
    }
    lockShellHeight(shell, height) {
      const safeHeight = Math.max(1, Math.ceil(height || this.getShellHeightBaseline(shell)));
      shell.style.height = `${safeHeight}px`;
      shell.style.minHeight = `${safeHeight}px`;
      shell.style.overflow = "hidden";
      shell._snaptexLastHeight = safeHeight;
    }
    unlockShellHeight(shell) {
      shell.style.height = "";
      shell.style.minHeight = "";
      shell.style.overflow = "";
      shell._snaptexLastHeight = this.getShellHeightBaseline(shell);
    }
    measureMountedBlockHeight(shell) {
      const block = this.getShellBlock(shell);
      if (!block) return this.getShellHeightBaseline(shell);
      return Math.ceil(block.getBoundingClientRect().height || block.scrollHeight || this.getShellHeightBaseline(shell));
    }
    isShellAboveViewport(shell) {
      return shell.getBoundingClientRect().bottom <= 0;
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
      shell._snaptexLastHeight = this.getShellHeightBaseline(shell);
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
      entries.forEach((entry) => {
        const shell = entry.target;
        const nextHeight = entry.contentRect.height;
        shell._snaptexLastHeight = nextHeight;
        const key = this.getBlockKey(shell);
        if (key && nextHeight > 0) {
          this.heightCache.set(key, Math.ceil(nextHeight));
        }
      });
    }
    createShellForBlock(block) {
      const index = this.getBlockIndex(block);
      const hash = block.getAttribute("data-block-hash") || "";
      const key = this.getBlockKey(block);
      const html = block.outerHTML;
      const shell = document.createElement("div");
      shell.className = "latex-block-shell";
      if (index !== null) {
        shell.setAttribute("data-index", index);
      }
      if (hash) {
        shell.setAttribute("data-block-hash", hash);
      }
      if (key) {
        shell.setAttribute("data-block-key", key);
      }
      this.htmlCache.set(key || index, html);
      const cachedHeight = this.heightCache.get(key);
      const estimatedHeight = cachedHeight || this.estimateBlockHeightFromHtml(html);
      this.lockShellHeight(shell, estimatedHeight);
      shell.setAttribute("data-mounted", "false");
      shell.setAttribute("data-html-loaded", "true");
      this.setShellAnchors(shell, this.getAnchorIdsFromBlock(block));
      this.observeShell(shell);
      return shell;
    }
    createShellForMeta(meta) {
      const shell = document.createElement("div");
      shell.className = "latex-block-shell";
      shell.setAttribute("data-index", String(meta.index));
      shell.setAttribute("data-block-hash", meta.hash);
      shell.setAttribute("data-block-key", meta.hash || String(meta.index));
      shell.setAttribute("data-line", String(meta.line ?? 0));
      shell.setAttribute("data-line-count", String(meta.lineCount ?? 1));
      shell.setAttribute("data-mounted", "false");
      shell.setAttribute("data-html-loaded", "false");
      const cachedHeight = this.heightCache.get(meta.hash);
      const estimatedHeight = cachedHeight || this.estimateBlockHeightFromMeta(meta);
      this.lockShellHeight(shell, estimatedHeight);
      this.setShellAnchors(shell, meta.anchors);
      this.observeShell(shell);
      return shell;
    }
    getShells() {
      return Array.from(this.contentRoot.querySelectorAll(".latex-block-shell"));
    }
    getShellBlock(shell) {
      return shell ? shell.querySelector(":scope > .latex-block") : null;
    }
    getMountMargins(direction) {
      let above = BLOCK_VIRTUALIZATION_BASE_PRELOAD_MARGIN;
      let below = BLOCK_VIRTUALIZATION_BASE_PRELOAD_MARGIN;
      if (direction === "up") {
        above += BLOCK_VIRTUALIZATION_DIRECTIONAL_PRELOAD_MARGIN;
      } else if (direction === "down") {
        below += BLOCK_VIRTUALIZATION_DIRECTIONAL_PRELOAD_MARGIN;
      }
      return { above, below };
    }
    isShellInMountRange(shell, direction = "none") {
      const rect = shell.getBoundingClientRect();
      const margins = this.getMountMargins(direction);
      return rect.bottom >= -margins.above && rect.top <= window.innerHeight + margins.below;
    }
    isShellInRetainRange(shell) {
      const rect = shell.getBoundingClientRect();
      return rect.bottom >= -BLOCK_VIRTUALIZATION_RETAIN_MARGIN && rect.top <= window.innerHeight + BLOCK_VIRTUALIZATION_RETAIN_MARGIN;
    }
    isShellNearViewport(shell, direction = "none") {
      return this.isShellInMountRange(shell, direction);
    }
    mountShell(shell, onMissingHtml) {
      if (!this.enabled || this.getShellBlock(shell)) return null;
      const key = this.getBlockKey(shell);
      const html = this.htmlCache.get(key) || this.htmlCache.get(this.getBlockIndex(shell));
      if (!html) {
        if (onMissingHtml) {
          onMissingHtml(shell);
        }
        return null;
      }
      const block = this.parseBlockHtml(html);
      if (!block) return null;
      const reservedHeight = this.getShellHeightBaseline(shell);
      shell.textContent = "";
      shell.appendChild(block);
      if (this.isShellAboveViewport(shell)) {
        this.lockShellHeight(shell, reservedHeight);
      } else {
        this.unlockShellHeight(shell);
      }
      shell.setAttribute("data-mounted", "true");
      shell.setAttribute("data-html-loaded", "true");
      this.setShellAnchors(shell, this.getAnchorIdsFromBlock(block));
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
      shell.setAttribute("data-mounted", "false");
    }
    updateMountedShells(onMount, onMissingHtml, options = {}) {
      if (!this.enabled) return [];
      const mounted = [];
      const direction = options.direction || "none";
      const allowUnmount = options.allowUnmount !== false;
      this.getShells().forEach((shell) => {
        if (this.isShellInMountRange(shell, direction)) {
          const block = this.mountShell(shell, onMissingHtml);
          if (block) {
            mounted.push(block);
            if (onMount) {
              onMount(block);
            }
          } else {
            this.refreshMountedShellHeight(shell);
          }
        } else if (allowUnmount && this.getShellBlock(shell) && !this.isShellInRetainRange(shell)) {
          this.unmountShell(shell);
        }
      });
      return mounted;
    }
    replaceContentWithShells(blocks, onMount) {
      const fragment = document.createDocumentFragment();
      blocks.forEach((block) => fragment.appendChild(this.createShellForBlock(block)));
      this.disconnectShellObservers();
      Array.from(fragment.children).forEach((shell) => this.observeShell(shell));
      this.contentRoot.replaceChildren(fragment);
      this.updateMountedShells(onMount);
    }
    replaceContentWithBlockMetadata(blocks, onMount, onMissingHtml) {
      const fragment = document.createDocumentFragment();
      blocks.forEach((meta) => fragment.appendChild(this.createShellForMeta(meta)));
      this.disconnectShellObservers();
      Array.from(fragment.children).forEach((shell) => this.observeShell(shell));
      this.contentRoot.replaceChildren(fragment);
      this.updateMountedShells(onMount, onMissingHtml);
    }
    storeBlockHtml(index, hash, html) {
      const key = hash || String(index);
      const shell = this.contentRoot.querySelector(`.latex-block-shell[data-index="${index}"]`);
      if (!shell) return null;
      const shellHash = shell.getAttribute("data-block-hash") || "";
      if (hash && shellHash && shellHash !== hash) return null;
      this.htmlCache.set(key, html);
      shell.removeAttribute("data-html-requested");
      shell.setAttribute("data-html-loaded", "true");
      return shell;
    }
    remapShellIndices(start, delta) {
      if (delta === 0) return;
      this.getShells().forEach((shell) => {
        const oldIdx = parseInt(shell.getAttribute("data-index"));
        if (!isNaN(oldIdx) && oldIdx >= start) {
          shell.setAttribute("data-index", oldIdx + delta);
          const block = this.getShellBlock(shell);
          if (block) {
            block.setAttribute("data-index", oldIdx + delta);
          }
        }
      });
    }
  };

  // src/webview/tikz.ts
  window.tikzJaxJsUri = document.body.dataset.tikzJaxJsUri || "";
  window.tikzJaxLoadPromise = null;
  window.tikzJaxFailed = false;
  var TIKZ_ACTIVE_RENDER_TIMEOUT_MS = 6e4;
  var TIKZ_BATCH_RENDER_TIMEOUT_MS = 65e3;
  var TIKZ_RENDER_DEBOUNCE_MS = 200;
  var TIKZ_PENDING_SCRIPT_TYPE = "text/snaptex-tikz";
  var TIKZ_ACTIVE_SCRIPT_TYPE = "text/tikz";
  var TIKZ_PENDING_SCRIPT_SELECTOR = `script[type="${TIKZ_PENDING_SCRIPT_TYPE}"]`;
  var TIKZ_SCRIPT_SELECTOR = `${TIKZ_PENDING_SCRIPT_SELECTOR}, script[type="${TIKZ_ACTIVE_SCRIPT_TYPE}"]`;
  function hasRenderedTikz(container) {
    return !!container.querySelector('svg[role="img"]:not(.tikz-stale-preview)');
  }
  function notifyTikzContainerSettled(container) {
    if (!container || !container.isConnected) return;
    container.dispatchEvent(new CustomEvent("snaptex-tikz-settled", { bubbles: true }));
  }
  window.ensureTikzJaxLoaded = function() {
    if (window.TikzJax) {
      return Promise.resolve();
    }
    if (window.tikzJaxFailed) {
      return Promise.reject(new Error("TikZJax is disabled after a previous load failure."));
    }
    if (window.tikzJaxLoadPromise) {
      return window.tikzJaxLoadPromise;
    }
    window.tikzJaxLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = window.tikzJaxJsUri;
      script.id = "tikzjax-script";
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => {
        window.tikzJaxFailed = true;
        window.tikzJaxLoadPromise = null;
        reject(new Error("Failed to load TikZJax."));
      };
      document.head.appendChild(script);
    });
    return window.tikzJaxLoadPromise;
  };
  window.addEventListener("unhandledrejection", (event) => {
    const message = String(event.reason?.message || event.reason || "");
    if (message.includes("Did not receive an init message") || message.includes("run-tex.js")) {
      window.tikzJaxFailed = true;
      window.failPendingTikzContainers("TikZ rendering failed.");
      console.warn("[SnapTeX] TikZJax worker failed; disabling TikZ rendering for this webview session.", event.reason);
    }
  });
  function getTikzContainerFromEvent(event) {
    const target = event.target;
    return target && target.closest ? target.closest(".tikz-container") : null;
  }
  function setTikzContainerState(container, state) {
    container.setAttribute("data-tikz-state", state);
  }
  function clearTikzRenderTimer(container) {
    if (container.__snaptexTikzRenderTimer) {
      clearTimeout(container.__snaptexTikzRenderTimer);
      container.__snaptexTikzRenderTimer = null;
    }
  }
  function armTikzRenderTimer(container) {
    clearTikzRenderTimer(container);
    container.__snaptexTikzRenderTimer = setTimeout(() => {
      if (!container.isConnected || hasRenderedTikz(container)) return;
      window.failTikzContainer(container, "TikZ rendering timed out.");
    }, TIKZ_ACTIVE_RENDER_TIMEOUT_MS);
  }
  window.failTikzContainer = function(container, message) {
    if (!container || !container.isConnected) return;
    const state = container.getAttribute("data-tikz-state");
    const isActive = state === "queued" || state === "rendering" || state === "stale";
    if (hasRenderedTikz(container) && !isActive) return;
    clearTikzRenderTimer(container);
    setTikzContainerState(container, "failed");
    const errorEl = document.createElement("div");
    errorEl.className = "tikz-error";
    errorEl.style.cssText = "padding: 12px; color: #8a1f11; background: #fff3f0; border: 1px solid #f0c6bd; font: 12px sans-serif;";
    errorEl.textContent = message;
    container.replaceChildren(errorEl);
    notifyTikzContainerSettled(container);
  };
  window.failPendingTikzContainers = function(message) {
    document.querySelectorAll(".tikz-container").forEach((container) => {
      window.failTikzContainer(container, message);
    });
  };
  window.watchPendingTikzContainers = function(root = document) {
    root.querySelectorAll(".tikz-container").forEach((container) => {
      if (hasRenderedTikz(container) || container.getAttribute("data-tikz-state") === "failed") return;
      setTikzContainerState(container, "queued");
      container.setAttribute("data-tikz-watchdog", "true");
    });
  };
  window.activatePendingTikzScripts = function(root = document) {
    const pendingScripts = Array.from(root.querySelectorAll(TIKZ_PENDING_SCRIPT_SELECTOR));
    pendingScripts.forEach((script) => {
      if (!script.isConnected) return;
      const activeScript = document.createElement("script");
      for (const attr of script.attributes) {
        if (attr.name !== "type") {
          activeScript.setAttribute(attr.name, attr.value);
        }
      }
      activeScript.type = TIKZ_ACTIVE_SCRIPT_TYPE;
      activeScript.textContent = script.textContent;
      script.replaceWith(activeScript);
    });
    return pendingScripts.length;
  };
  document.addEventListener("tikzjax-tex-input", (event) => {
    const container = getTikzContainerFromEvent(event);
    if (!container) return;
    setTikzContainerState(container, "rendering");
    armTikzRenderTimer(container);
  });
  document.addEventListener("tikzjax-load-finished", (event) => {
    const container = getTikzContainerFromEvent(event);
    if (!container) return;
    clearTikzRenderTimer(container);
    container.querySelectorAll(".tikz-stale-preview").forEach((preview) => preview.remove());
    setTikzContainerState(container, "rendered");
    notifyTikzContainerSettled(container);
  });
  document.addEventListener("tikzjax-load-failed", (event) => {
    const container = getTikzContainerFromEvent(event);
    if (!container) return;
    const message = event.detail?.message || "TikZ rendering failed.";
    window.failTikzContainer(container, message);
  });

  // src/webview/main.ts
  var vscode = window.snaptexVsCodeApi || acquireVsCodeApi();
  window.snaptexVsCodeApi = vscode;
  var PDF_RENDER_MARGIN = 1200;
  var PDF_RELEASE_MARGIN = 3600;
  window.pdfReqQueue = [];
  window.renderPdfToCanvas = function(path, canvasId) {
    console.log(`[SnapTeX] Queueing PDF request for ${canvasId}`);
    window.pdfReqQueue.push({ path, canvasId });
  };
  var TooltipManager = class {
    constructor() {
      this.activeTransientTooltip = null;
      this.zIndexCounter = 1e3;
      this.bindGlobalEvents();
    }
    bindGlobalEvents() {
      document.body.addEventListener("mouseover", (e) => {
        const link = e.target.closest("a");
        if (link && link.getAttribute("href")?.startsWith("#")) {
          const parentTooltip = link.closest(".hover-tooltip");
          if (parentTooltip && !parentTooltip.classList.contains("pinned")) {
            return;
          }
          this.onLinkEnter(link);
        }
      });
      document.body.addEventListener("mouseout", (e) => {
        const link = e.target.closest("a");
        if (link && link.getAttribute("href")?.startsWith("#")) {
          if (this.activeTransientTooltip && this.activeTransientTooltip.element.contains(e.relatedTarget)) {
            return;
          }
          this.onLinkLeave();
        }
      });
      window.addEventListener("mousemove", (e) => this.broadcastMouseMove(e));
      window.addEventListener("mouseup", () => this.broadcastMouseUp());
    }
    onLinkEnter(link) {
      if (!this.activeTransientTooltip || this.activeTransientTooltip.isPinned) {
        this.activeTransientTooltip = new Tooltip(this);
      }
      this.activeTransientTooltip.scheduleShow(link);
    }
    onLinkLeave() {
      if (this.activeTransientTooltip) {
        this.activeTransientTooltip.onLinkLeave();
      }
    }
    getTopZIndex() {
      return ++this.zIndexCounter;
    }
    // Notify all tooltips of mouse moves (for drag/resize)
    broadcastMouseMove(e) {
    }
    broadcastMouseUp() {
    }
  };
  var Tooltip = class {
    constructor(manager) {
      this.manager = manager;
      this.element = this.createDOM();
      document.body.appendChild(this.element);
      this.header = this.element.querySelector(".tooltip-header");
      this.contentContainer = this.element.querySelector(".tooltip-content");
      this.pinBtn = this.element.querySelector(".pin-btn");
      this.closeBtn = this.element.querySelector(".close-btn");
      this.resizeRight = this.element.querySelector(".resize-handle-right");
      this.resizeBottom = this.element.querySelector(".resize-handle-bottom");
      this.resizeCorner = this.element.querySelector(".resize-handle-corner");
      this.isPinned = false;
      this.currentLink = null;
      this.hideTimer = null;
      this.showTimer = null;
      this.isDragging = false;
      this.resizeState = null;
      this.bindEvents();
      this.bringToFront();
    }
    createDOM() {
      const el = document.createElement("div");
      el.className = "hover-tooltip";
      el.innerHTML = `
                <div class="tooltip-header">
                    <span class="drag-handle-icon">::::</span>
                    <div class="header-controls">
                        <button class="icon-btn pin-btn" title="Pin / Unpin">\u{1F4CC}</button>
                        <button class="icon-btn close-btn" title="Close">\u2715</button>
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
      this.element.addEventListener("mouseenter", () => this.clearHideTimer());
      this.element.addEventListener("mouseleave", () => this.startHideTimer());
      this.element.addEventListener("mousedown", () => this.bringToFront());
      this.pinBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.togglePin();
      });
      this.closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.dispose();
      });
      this.header.addEventListener("mousedown", (e) => this.startDrag(e));
      this.resizeBottom.addEventListener("mousedown", (e) => this.startResize(e, false, true));
      this.resizeRight.addEventListener("mousedown", (e) => this.startResize(e, true, false));
      this.resizeCorner.addEventListener("mousedown", (e) => this.startResize(e, true, true));
      this._onWindowMouseMove = (e) => this.onMouseMove(e);
      this._onWindowMouseUp = (e) => this.onMouseUp(e);
      window.addEventListener("mousemove", this._onWindowMouseMove);
      window.addEventListener("mouseup", this._onWindowMouseUp);
    }
    bringToFront() {
      this.element.style.zIndex = this.manager.getTopZIndex();
    }
    togglePin() {
      this.isPinned = !this.isPinned;
      if (this.isPinned) {
        this.pinBtn.classList.add("active");
        this.element.classList.add("pinned");
        this.clearHideTimer();
        if (this.manager.activeTransientTooltip === this) {
          this.manager.activeTransientTooltip = null;
        }
      } else {
        this.pinBtn.classList.remove("active");
        this.element.classList.remove("pinned");
        if (!this.element.matches(":hover")) {
          this.startHideTimer();
        }
      }
    }
    dispose() {
      if (this.element && this.element.parentNode) {
        this.element.parentNode.removeChild(this.element);
      }
      window.removeEventListener("mousemove", this._onWindowMouseMove);
      window.removeEventListener("mouseup", this._onWindowMouseUp);
      if (this.manager.activeTransientTooltip === this) {
        this.manager.activeTransientTooltip = null;
      }
    }
    // --- Drag Logic ---
    startDrag(e) {
      this.isDragging = true;
      this.ensureAbsolutePosition();
      const rect = this.element.getBoundingClientRect();
      this.element.style.cursor = "grabbing";
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
        // Using rect.width is safer with border-box
        startHeight: rect.height,
        dirX,
        dirY
      };
      this.element.style.maxHeight = "none";
      this.element.style.maxWidth = "none";
      e.preventDefault();
      e.stopPropagation();
    }
    ensureAbsolutePosition() {
      const rect = this.element.getBoundingClientRect();
      this.element.style.transform = "none";
      this.element.style.left = `${rect.left}px`;
      this.element.style.top = `${rect.top}px`;
      this.element.style.bottom = "";
      this.element.style.width = `${rect.width}px`;
      this.element.style.height = `${rect.height}px`;
    }
    onMouseMove(e) {
      if (this.isDragging) {
        const x = e.clientX - this.dragOffset.x;
        const y = e.clientY - this.dragOffset.y;
        this.element.style.left = `${x}px`;
        this.element.style.top = `${y}px`;
        this.element.style.transform = "none";
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
      this.element.style.cursor = "";
    }
    // --- Show/Hide Logic ---
    scheduleShow(link) {
      this.clearHideTimer();
      if (this.currentLink === link && this.element.classList.contains("visible")) return;
      if (this.showTimer) clearTimeout(this.showTimer);
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
      const targetId = link.getAttribute("href").substring(1);
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
      this.element.classList.remove("visible");
      setTimeout(() => {
        if (!this.element.classList.contains("visible")) {
          this.dispose();
        }
      }, 200);
    }
    async showPreview(linkElement, targetId) {
      const targetEl = await this.resolveTargetElement(targetId);
      if (this.currentLink !== linkElement) return;
      if (!targetEl) return;
      const container = targetEl.closest(".latex-block") || targetEl.closest(".bib-item");
      if (!container) return;
      this.contentContainer.innerHTML = "";
      const frag = document.createDocumentFragment();
      if (container.classList.contains("latex-block")) {
        const prev = container.previousElementSibling;
        if (prev && prev.classList.contains("latex-block")) {
          const clone = prev.cloneNode(true);
          clone.classList.add("context-block");
          this.cleanNode(clone);
          frag.appendChild(clone);
        }
        const current = container.cloneNode(true);
        current.classList.add("target-block");
        this.cleanNode(current);
        frag.appendChild(current);
        const next = container.nextElementSibling;
        if (next && next.classList.contains("latex-block")) {
          const clone = next.cloneNode(true);
          clone.classList.add("context-block");
          this.cleanNode(clone);
          frag.appendChild(clone);
        }
      } else {
        const clone = container.cloneNode(true);
        this.cleanNode(clone);
        frag.appendChild(clone);
      }
      this.contentContainer.appendChild(frag);
      this.refreshPDFs();
      this.positionTooltip(linkElement);
      setTimeout(() => {
        this.triggerTikzRendering();
      }, 10);
      requestAnimationFrame(() => {
        this.element.classList.add("visible");
      });
    }
    async resolveTargetElement(targetId) {
      const existing = document.getElementById(targetId);
      if (existing) return existing;
      const controller2 = window.snaptexPreviewController;
      if (controller2 && typeof controller2.ensureAnchorMounted === "function") {
        return await controller2.ensureAnchorMounted(targetId);
      }
      return null;
    }
    triggerTikzRendering() {
      if (this.contentContainer.querySelector(TIKZ_SCRIPT_SELECTOR)) {
        window.watchPendingTikzContainers(this.contentContainer);
        window.activatePendingTikzScripts(this.contentContainer);
        window.ensureTikzJaxLoaded().catch((error) => {
          window.failPendingTikzContainers("TikZ rendering failed.");
          console.warn("[SnapTeX] Failed to load TikZJax for tooltip content.", error);
        });
      }
    }
    cleanNode(node) {
      if (node.id) node.removeAttribute("id");
      node.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
    }
    refreshPDFs() {
      const canvases = this.contentContainer.querySelectorAll("canvas[data-req-path]");
      canvases.forEach((canvas) => {
        const newId = "tooltip-pdf-" + Math.random().toString(36).substr(2, 9);
        canvas.id = newId;
        canvas.removeAttribute("data-rendered");
        canvas.removeAttribute("data-requested");
        const path = canvas.getAttribute("data-req-path");
        if (path) {
          window.renderPdfToCanvas(path, newId);
        }
      });
    }
    positionTooltip(linkElement) {
      const linkRect = linkElement.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const margin = 15;
      const isTopHalf = linkRect.top < viewportHeight / 2;
      if (isTopHalf) {
        this.element.style.top = `${linkRect.bottom + margin}px`;
      } else {
        const bottomDist = viewportHeight - linkRect.top + margin;
        this.element.style.bottom = `${bottomDist}px`;
        this.element.style.top = "auto";
      }
    }
  };
  var PreviewController = class {
    constructor() {
      this.contentRoot = document.getElementById("content-root");
      this.state = "SCROLLING_AUTO";
      this.scrollTimeout = null;
      this.pendingScroll = null;
      this.isFirstLoad = true;
      this.lastTargetIndex = -1;
      this.lastTargetRatio = 0;
      this.lastScrollTime = 0;
      this.scrollCommandSeq = 0;
      this.lastVirtualScrollY = window.scrollY;
      this.scrollDirection = "none";
      this.virtualUpdateFrame = null;
      this.virtualCleanupTimer = null;
      this.config = {
        autoScrollDelay: 100,
        debugMemory: false,
        experimentalVirtualization: false
      };
      this.currentNumbering = null;
      this.blockHtmlRequestSeq = 0;
      this.pendingBlockHtmlRequests = /* @__PURE__ */ new Map();
      this.pdfObserver = null;
      this.pdfRenderTimer = null;
      this.virtualization = new BlockVirtualizationController(this.contentRoot);
      window.snaptexPreviewController = this;
      this.tikzRenderScheduler = new CoalescingTaskScheduler({
        debounceMs: TIKZ_RENDER_DEBOUNCE_MS,
        run: () => this.runTikzRenderBatch(),
        onError: (error) => {
          window.failPendingTikzContainers("TikZ rendering failed.");
          console.warn("[SnapTeX] Failed to render TikZ preview content.", error);
        }
      });
      this.tooltipManager = new TooltipManager();
      this.initPdfObserver();
      this.bindEvents();
      vscode.postMessage({ command: "webviewLoaded" });
    }
    bindEvents() {
      window.addEventListener("message", (event) => this.onMessage(event));
      window.addEventListener("scroll", () => {
        this.updateScrollDirection();
        this.requestVirtualizedUpdate({ allowUnmount: false });
        this.scheduleVirtualizedCleanup();
        this.onScroll();
      });
      window.addEventListener("resize", () => this.updateVirtualizedBlocks({ allowUnmount: true }));
      document.addEventListener("dblclick", (event) => this.onDoubleClick(event));
      document.addEventListener("click", (event) => this.onInternalLinkClick(event));
    }
    setState(newState) {
      this.state = newState;
    }
    lockScrolling(duration) {
      this.setState("SCROLLING_AUTO");
      if (this.scrollTimeout) clearTimeout(this.scrollTimeout);
      this.scrollTimeout = setTimeout(() => {
        if (this.state === "SCROLLING_AUTO") {
          this.setState("IDLE");
        }
      }, duration);
    }
    onMessage(event) {
      const { command, payload, binaryData } = event.data;
      switch (command) {
        case "update":
          this.handleUpdate(payload);
          break;
        case "update_binary":
          let u8array;
          if (binaryData instanceof Uint8Array) {
            u8array = binaryData;
          } else if (binaryData && binaryData.type === "Buffer") {
            u8array = new Uint8Array(binaryData.data);
          } else {
            u8array = new Uint8Array(binaryData);
          }
          const decoder = new TextDecoder("utf-8");
          const htmlString = decoder.decode(u8array);
          payload.html = htmlString;
          this.handleUpdate(payload);
          break;
        case "scrollToBlock":
          this.handleScrollCommand(event.data);
          break;
        case "blockHtml":
          this.handleBlockHtml(event.data);
          break;
        case "config":
          if (event.data.config && typeof event.data.config.autoScrollDelay === "number") {
            this.config.autoScrollDelay = Math.max(0, event.data.config.autoScrollDelay);
          }
          if (event.data.config && typeof event.data.config.debugMemory === "boolean") {
            this.config.debugMemory = event.data.config.debugMemory;
          }
          this.config.experimentalVirtualization = event.data.config.experimentalVirtualization === true;
          this.virtualization.setEnabled(event.data.config.experimentalVirtualization === true);
          this.updateVirtualizedBlocks({ allowUnmount: true });
          break;
      }
    }
    handleUpdate(payload) {
      if (payload.numbering) {
        this.currentNumbering = payload.numbering;
      }
      if (payload.type === "full") {
        this.setState("RENDERING");
        const scrollState = this.saveScrollState();
        document.body.classList.add("preload-mode");
        if (payload.blocks && this.virtualization.isEnabled()) {
          this.smartFullUpdateFromBlockMetadata(payload.blocks, payload.preserveUnchangedBlocks !== false);
        } else if (payload.htmls) {
          this.smartFullUpdateFromBlocks(payload.htmls, payload.preserveUnchangedBlocks !== false);
        } else {
          this.smartFullUpdate(payload.html, payload.preserveUnchangedBlocks !== false);
        }
        this.logDomStats("after full update");
        document.fonts.ready.then(() => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              this.onRenderComplete(scrollState);
            });
          });
        });
      } else if (payload.type === "patch") {
        this.applyPatch(payload);
        this.logDomStats("after patch update");
      }
      if (payload.numbering) {
        requestAnimationFrame(() => this.applyNumbering(payload.numbering));
      }
      this.schedulePendingPdfRender();
      this.triggerTikzRendering();
    }
    logDomStats(label) {
      if (!this.config.debugMemory) return;
      console.log("[SnapTeX][webview]", label, {
        blocks: document.querySelectorAll(".latex-block").length,
        shells: document.querySelectorAll(".latex-block-shell").length,
        mountedShells: document.querySelectorAll('.latex-block-shell[data-mounted="true"]').length,
        pdfCanvases: document.querySelectorAll("canvas[data-req-path]").length,
        renderedPdfs: document.querySelectorAll('canvas[data-rendered="true"]').length,
        tikzScripts: document.querySelectorAll('script[type="text/tikz"]').length,
        svgCount: document.querySelectorAll("svg").length,
        scrollHeight: document.documentElement.scrollHeight
      });
    }
    collectTikzPreviews(block) {
      if (!block) return [];
      return Array.from(block.querySelectorAll(".tikz-container")).map((container) => {
        const rendered = container.querySelector('svg[role="img"]:not(.tikz-stale-preview)');
        return rendered ? rendered.cloneNode(true) : null;
      });
    }
    attachStaleTikzPreviews(block, previews) {
      if (!block || !previews || previews.length === 0) return;
      const containers = Array.from(block.querySelectorAll(".tikz-container"));
      containers.forEach((container, index) => {
        if (hasRenderedTikz(container) || container.querySelector(".tikz-stale-preview")) return;
        const preview = previews[index];
        if (!preview) return;
        preview.classList.add("tikz-stale-preview");
        container.appendChild(preview);
        setTikzContainerState(container, "stale");
      });
    }
    applyStaleTikzPreviewsToBlock(newBlock, oldBlock) {
      const previews = this.collectTikzPreviews(oldBlock);
      this.attachStaleTikzPreviews(newBlock, previews);
    }
    replaceBlockPreservingTikz(oldBlock, newBlock) {
      this.virtualization.rememberBlockHeight(oldBlock);
      oldBlock.replaceWith(newBlock);
      this.applyStaleTikzPreviewsToBlock(newBlock, oldBlock);
    }
    onVirtualBlockMounted(block) {
      if (!block) return;
      if (this.currentNumbering) {
        requestAnimationFrame(() => this.applyNumbering(this.currentNumbering));
      }
      this.schedulePendingPdfRender();
      this.triggerTikzRendering();
    }
    updateScrollDirection() {
      const currentY = window.scrollY;
      const delta = currentY - this.lastVirtualScrollY;
      if (Math.abs(delta) > 2) {
        this.scrollDirection = delta < 0 ? "up" : "down";
        this.lastVirtualScrollY = currentY;
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
        this.updateVirtualizedBlocks({ allowUnmount: true });
      }, BLOCK_VIRTUALIZATION_CLEANUP_DELAY_MS);
    }
    updateVirtualizedBlocks(options = {}) {
      if (!this.virtualization.isEnabled()) return;
      this.virtualization.updateMountedShells(
        (block) => this.onVirtualBlockMounted(block),
        (shell) => this.requestVirtualBlockHtml(shell),
        {
          direction: this.scrollDirection,
          allowUnmount: options.allowUnmount !== false
        }
      );
    }
    getBlockByIndex(index) {
      return document.querySelector('.latex-block[data-index="' + index + '"]');
    }
    getShellByIndex(index) {
      return document.querySelector('.latex-block-shell[data-index="' + index + '"]');
    }
    getBlockOrShellByIndex(index) {
      let target = this.getBlockByIndex(index);
      if (target) return target;
      const shell = this.getShellByIndex(index);
      if (!shell) return null;
      const mounted = this.virtualization.mountShell(shell, (missingShell) => this.requestVirtualBlockHtml(missingShell));
      if (mounted) {
        this.onVirtualBlockMounted(mounted);
        return mounted;
      }
      return shell;
    }
    waitForLayout() {
      return new Promise((resolve) => {
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
        (missingShell) => this.requestVirtualBlockHtml(missingShell)
      );
      if (mounted) {
        this.onVirtualBlockMounted(mounted);
        return Promise.resolve(mounted);
      }
      return new Promise((resolve) => {
        let resolved = false;
        const finish = (block) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          resolve(block || null);
        };
        const timeout = setTimeout(() => finish(null), 6e3);
        const requested = this.requestVirtualBlockHtml(shell, {
          forceMount: true,
          onLoaded: finish
        });
        if (!requested) {
          finish(null);
        }
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
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return document.getElementById(anchorId);
    }
    async onInternalLinkClick(event) {
      const link = event.target.closest("a");
      const href = link?.getAttribute("href");
      if (!href || !href.startsWith("#") || href.length <= 1) return;
      event.preventDefault();
      let anchorId = href.substring(1);
      try {
        anchorId = decodeURIComponent(anchorId);
      } catch {
      }
      const target = await this.ensureAnchorMounted(anchorId);
      if (!target) return;
      const targetY = target.getBoundingClientRect().top + window.scrollY - Math.round(window.innerHeight * 0.25);
      this.lockScrolling(900);
      window.scrollTo({ top: Math.max(0, targetY), behavior: "auto" });
      const block = target.closest(".latex-block") || target.closest(".bib-item") || target;
      block.classList.add("jump-highlight");
      setTimeout(() => block.classList.remove("jump-highlight"), 1e3);
    }
    requestVirtualBlockHtml(shell, options = {}) {
      if (!shell) return false;
      const requestOptions = typeof options === "function" ? { onLoaded: options, forceMount: true } : options;
      const existingId = shell.getAttribute("data-html-request-id");
      if (existingId && this.pendingBlockHtmlRequests.has(existingId)) {
        const pending = this.pendingBlockHtmlRequests.get(existingId);
        if (requestOptions.onLoaded) {
          pending.callbacks.push(requestOptions.onLoaded);
        }
        pending.forceMount = pending.forceMount || requestOptions.forceMount === true;
        return true;
      }
      const index = parseInt(shell.getAttribute("data-index"));
      const hash = shell.getAttribute("data-block-hash") || "";
      if (Number.isNaN(index)) return false;
      const id = `block-${++this.blockHtmlRequestSeq}`;
      shell.setAttribute("data-html-requested", "true");
      shell.setAttribute("data-html-request-id", id);
      this.pendingBlockHtmlRequests.set(id, {
        index,
        hash,
        forceMount: requestOptions.forceMount === true,
        callbacks: requestOptions.onLoaded ? [requestOptions.onLoaded] : []
      });
      vscode.postMessage({ command: "requestBlockHtml", id, index, hash });
      return true;
    }
    handleBlockHtml(message) {
      const pending = this.pendingBlockHtmlRequests.get(message.id);
      if (pending) {
        this.pendingBlockHtmlRequests.delete(message.id);
      }
      if (message.error || !message.html) {
        const index2 = pending?.index ?? message.index;
        const shell2 = this.getShellByIndex(index2);
        if (shell2) {
          shell2.removeAttribute("data-html-requested");
          shell2.removeAttribute("data-html-request-id");
        }
        pending?.callbacks?.forEach((callback) => callback(null));
        return;
      }
      const index = typeof message.index === "number" ? message.index : pending?.index;
      const hash = message.hash || pending?.hash || "";
      const shell = this.virtualization.storeBlockHtml(index, hash, message.html);
      if (shell) {
        shell.removeAttribute("data-html-request-id");
      }
      if (!shell) {
        pending?.callbacks?.forEach((callback) => callback(null));
        return;
      }
      if (!pending?.forceMount && !this.virtualization.isShellNearViewport(shell, this.scrollDirection)) return;
      const block = this.virtualization.mountShell(
        shell,
        (missingShell) => this.requestVirtualBlockHtml(missingShell)
      );
      if (block) {
        this.onVirtualBlockMounted(block);
      }
      pending?.callbacks?.forEach((callback) => callback(block || null));
    }
    getPendingTikzContainers(root = document) {
      return Array.from(root.querySelectorAll(".tikz-container")).filter((container) => {
        if (hasRenderedTikz(container) || container.getAttribute("data-tikz-state") === "failed") return false;
        return !!container.querySelector(TIKZ_SCRIPT_SELECTOR);
      });
    }
    waitForTikzBatch(containers) {
      return new Promise((resolve) => {
        let interval = null;
        let timeout = null;
        let resolved = false;
        const isSettled = (container) => !container.isConnected || hasRenderedTikz(container) || container.getAttribute("data-tikz-state") === "failed";
        const cleanup = () => {
          document.removeEventListener("snaptex-tikz-settled", check, true);
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
        document.addEventListener("snaptex-tikz-settled", check, true);
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
      await window.ensureTikzJaxLoaded();
      const containers = this.getPendingTikzContainers(this.contentRoot);
      if (containers.length === 0 || window.tikzJaxFailed) return;
      console.log("[SnapTeX] Loading TikZJax for TikZ content...");
      window.watchPendingTikzContainers(this.contentRoot);
      const activated = window.activatePendingTikzScripts(this.contentRoot);
      if (activated === 0) return;
      await this.waitForTikzBatch(containers);
    }
    // Manually trigger TikZJax to scan the document
    triggerTikzRendering() {
      const pendingTikz = this.contentRoot.querySelector(TIKZ_SCRIPT_SELECTOR);
      if (!pendingTikz || window.tikzJaxFailed) return;
      window.ensureTikzJaxLoaded().catch(() => {
      });
      this.tikzRenderScheduler.request();
    }
    onRenderComplete(savedScrollState) {
      this.setState("IDLE");
      document.body.classList.remove("preload-mode");
      let scrollHandled = false;
      if (this.pendingScroll) {
        this.executeScroll(this.pendingScroll);
        this.pendingScroll = null;
        scrollHandled = true;
      } else if (!this.isFirstLoad) {
        this.restoreScrollState(savedScrollState);
        scrollHandled = true;
      }
      this.isFirstLoad = false;
      if (!scrollHandled && this.state === "SCROLLING_AUTO") {
        this.lockScrolling(200);
      } else if (!scrollHandled) {
        this.setState("IDLE");
      }
      this.schedulePendingPdfRender();
    }
    handleScrollCommand(data) {
      if (this.state === "RENDERING" || this.isFirstLoad) {
        this.pendingScroll = data;
      } else {
        this.executeScroll(data);
      }
    }
    onScroll() {
      if (this.state !== "IDLE") return;
      const now = Date.now();
      if (now - this.lastScrollTime < this.config.autoScrollDelay) return;
      this.lastScrollTime = now;
      const blocks = document.querySelectorAll(".latex-block, .latex-block-shell");
      const viewCenter = window.innerHeight / 2;
      for (const block of blocks) {
        const rect = block.getBoundingClientRect();
        if (rect.top <= viewCenter && rect.bottom >= viewCenter) {
          const index = parseInt(block.getAttribute("data-index"));
          let ratio = 0;
          if (rect.height > 0) {
            const offset = viewCenter - rect.top;
            ratio = Math.max(0, Math.min(1, offset / rect.height));
          }
          vscode.postMessage({ command: "syncScroll", index, ratio });
          break;
        }
      }
    }
    onDoubleClick(event) {
      const block = event.target.closest(".latex-block");
      if (block) {
        const index = block.getAttribute("data-index");
        if (index !== null) {
          const rect = block.getBoundingClientRect();
          const relativeY = event.clientY - rect.top;
          const ratio = Math.max(0, Math.min(1, relativeY / rect.height));
          let anchorText = "";
          const selection = window.getSelection();
          if (selection && selection.toString().trim().length > 0) {
            anchorText = selection.toString().trim();
          } else if (document.caretRangeFromPoint) {
            const range = document.caretRangeFromPoint(event.clientX, event.clientY);
            if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
              const text = range.startContainer.textContent;
              const offset = range.startOffset;
              let start = offset, end = offset;
              while (start > 0 && /\S/.test(text[start - 1])) start--;
              while (end < text.length && /\S/.test(text[end])) end++;
              if (end > start) {
                anchorText = text.substring(start, end);
              }
            }
          }
          vscode.postMessage({
            command: "revealLine",
            index: parseInt(index),
            ratio,
            anchor: anchorText,
            viewRatio: event.clientY / window.innerHeight
          });
        }
      }
    }
    saveScrollState() {
      const blocks = document.querySelectorAll(".latex-block, .latex-block-shell");
      for (const block of blocks) {
        const rect = block.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < window.innerHeight) {
          return { index: block.getAttribute("data-index"), ratio: -rect.top / rect.height, offset: -rect.top };
        }
      }
      return null;
    }
    restoreScrollState(state) {
      if (!state || !state.index) return;
      const block = this.getBlockOrShellByIndex(state.index);
      if (block) {
        const newTop = block.getBoundingClientRect().top + window.scrollY;
        let targetY = state.ratio >= 0 ? newTop + block.offsetHeight * state.ratio : newTop;
        this.lockScrolling(500);
        window.scrollTo({ top: targetY, behavior: "auto" });
      }
    }
    async executeScroll(data) {
      const { index, ratio, anchor, auto, viewRatio = 0.5 } = data;
      const scrollSeq = ++this.scrollCommandSeq;
      this.lastTargetIndex = index;
      this.lastTargetRatio = ratio || 0;
      const mountResult = await this.ensureBlockMountedByIndex(index);
      if (scrollSeq !== this.scrollCommandSeq) return;
      const target = mountResult.target;
      if (!auto || mountResult.mounted) {
        await this.waitForLayout();
        if (scrollSeq !== this.scrollCommandSeq) return;
      }
      if (target) {
        const calcY = () => {
          if (!target.isConnected) return window.scrollY;
          const rect = target.getBoundingClientRect();
          const absoluteTop = rect.top + window.scrollY;
          let y = absoluteTop + (ratio || 0) * rect.height - window.innerHeight * viewRatio;
          if (anchor) {
            const textTop = this.findTextOffsetInBlock(target, anchor);
            if (textTop !== null) {
              y = textTop + window.scrollY - window.innerHeight * viewRatio;
            }
          }
          return y;
        };
        const targetY = calcY();
        const currentY = window.scrollY;
        const autoSkipThreshold = 12;
        if (Math.abs(currentY - targetY) < autoSkipThreshold && auto) {
          return;
        }
        const lockTime = auto ? 600 : 1e3;
        this.lockScrolling(lockTime);
        window.scrollTo({ top: targetY, behavior: "auto" });
        if (!auto) {
          target.classList.add("jump-highlight");
          setTimeout(() => target.classList.remove("jump-highlight"), 1e3);
          if (anchor) this.highlightTextInNode(target, anchor);
        }
      }
    }
    shouldReplaceBlock(oldBlock, newBlock, preserveUnchangedBlocks) {
      if (!preserveUnchangedBlocks) return true;
      const oldHash = oldBlock.getAttribute("data-block-hash");
      const newHash = newBlock.getAttribute("data-block-hash");
      if (!oldHash || !newHash) return true;
      return oldHash !== newHash;
    }
    smartFullUpdate(newHtml, preserveUnchangedBlocks = true) {
      const parser = new DOMParser();
      const newDoc = parser.parseFromString(newHtml, "text/html");
      const newElements = Array.from(newDoc.body.children);
      this.smartFullUpdateElements(newElements, preserveUnchangedBlocks);
    }
    parseBlockHtml(html) {
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = html;
      return tempDiv.firstElementChild;
    }
    smartFullUpdateFromBlocks(htmls, preserveUnchangedBlocks = true) {
      const newElements = htmls.map((html) => this.parseBlockHtml(html)).filter(Boolean);
      this.smartFullUpdateElements(newElements, preserveUnchangedBlocks);
    }
    smartFullUpdateFromBlockMetadata(blocks, preserveUnchangedBlocks = true) {
      this.virtualization.replaceContentWithBlockMetadata(
        blocks,
        (block) => this.onVirtualBlockMounted(block),
        (shell) => this.requestVirtualBlockHtml(shell)
      );
    }
    smartFullUpdateElements(newElements, preserveUnchangedBlocks = true) {
      if (this.virtualization.isEnabled()) {
        this.virtualization.replaceContentWithShells(newElements, (block) => this.onVirtualBlockMounted(block));
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
        if (!oldEl) {
          this.contentRoot.appendChild(newEl);
          continue;
        }
        if (this.shouldReplaceBlock(oldEl, newEl, preserveUnchangedBlocks)) {
          this.replaceBlockPreservingTikz(oldEl, newEl);
        }
      }
    }
    applyPatch(payload) {
      if (this.virtualization.isEnabled()) {
        this.applyVirtualPatch(payload);
        return;
      }
      const { start, deleteCount, htmls = [], shift = 0 } = payload;
      const targetIndex = start + deleteCount;
      const referenceNode = this.contentRoot.children[targetIndex] || null;
      const staleTikzByIndex = /* @__PURE__ */ new Map();
      for (let i = 0; i < deleteCount; i++) {
        const block = this.contentRoot.children[start + i];
        const index = block?.getAttribute("data-index");
        const previews = this.collectTikzPreviews(block);
        this.virtualization.rememberBlockHeight(block);
        if (index !== null && previews.some(Boolean)) {
          staleTikzByIndex.set(index, previews);
        }
      }
      const insertedBlocks = [];
      for (let i = 0; i < deleteCount; i++) {
        if (this.contentRoot.children[start]) this.contentRoot.removeChild(this.contentRoot.children[start]);
      }
      if (htmls.length > 0) {
        const fragment = document.createDocumentFragment();
        const tempDiv = document.createElement("div");
        htmls.forEach((html) => {
          tempDiv.innerHTML = html;
          const node = tempDiv.firstElementChild;
          if (node) {
            insertedBlocks.push(node);
            fragment.appendChild(node);
          }
        });
        this.contentRoot.insertBefore(fragment, referenceNode);
        insertedBlocks.forEach((block) => {
          const index = block.getAttribute("data-index");
          this.attachStaleTikzPreviews(block, staleTikzByIndex.get(index));
        });
      }
      if (shift !== 0) {
        let node = this.contentRoot.children[start + htmls.length];
        while (node) {
          const oldIdx = parseInt(node.getAttribute("data-index"));
          if (!isNaN(oldIdx)) {
            node.setAttribute("data-index", oldIdx + shift);
          }
          node = node.nextElementSibling;
        }
      }
      if (payload.dirtyBlocks) {
        Object.keys(payload.dirtyBlocks).forEach((indexStr) => {
          const idx = parseInt(indexStr);
          const targetBlock = this.getBlockByIndex(idx);
          if (targetBlock) {
            const tempDiv = document.createElement("div");
            tempDiv.innerHTML = payload.dirtyBlocks[idx];
            const replacement = tempDiv.firstElementChild;
            if (replacement) {
              this.replaceBlockPreservingTikz(targetBlock, replacement);
            }
          }
        });
      }
    }
    applyVirtualPatch(payload) {
      const { start, deleteCount, htmls = [], shift = 0 } = payload;
      const referenceNode = this.contentRoot.children[start + deleteCount] || null;
      for (let i = 0; i < deleteCount; i++) {
        const shell = this.contentRoot.children[start];
        if (!shell) break;
        this.virtualization.rememberBlockHeight(shell);
        this.virtualization.unobserveShell(shell);
        shell.remove();
      }
      const tempDiv = document.createElement("div");
      const insertedShells = [];
      htmls.forEach((html) => {
        tempDiv.innerHTML = html;
        const block = tempDiv.firstElementChild;
        if (!block) return;
        const shell = this.virtualization.createShellForBlock(block);
        insertedShells.push(shell);
      });
      if (insertedShells.length > 0) {
        const fragment = document.createDocumentFragment();
        insertedShells.forEach((shell) => fragment.appendChild(shell));
        this.contentRoot.insertBefore(fragment, referenceNode);
      }
      if (shift !== 0) {
        this.virtualization.remapShellIndices(start + insertedShells.length, shift);
      }
      if (payload.dirtyBlocks) {
        Object.keys(payload.dirtyBlocks).forEach((indexStr) => {
          const idx = parseInt(indexStr);
          const shell = this.getShellByIndex(idx);
          if (!shell) return;
          const temp = document.createElement("div");
          temp.innerHTML = payload.dirtyBlocks[idx];
          const replacement = temp.firstElementChild;
          if (!replacement) return;
          const newShell = this.virtualization.createShellForBlock(replacement);
          this.virtualization.unobserveShell(shell);
          shell.replaceWith(newShell);
        });
      }
      this.updateVirtualizedBlocks();
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
          spans.forEach((span, i) => {
            if (values[i]) span.textContent = values[i];
          });
        };
        fill("eq", counts.eq);
        fill("fig", counts.fig);
        fill("tbl", counts.tbl);
        fill("alg", counts.alg);
        fill("sec", counts.sec);
        fill("thm", counts.thm);
      }
      if (labels) {
        const refs = document.querySelectorAll(".sn-ref");
        refs.forEach((ref) => {
          const key = ref.getAttribute("data-key");
          if (key && labels[key]) {
            ref.textContent = labels[key];
          } else {
            ref.textContent = "??";
          }
        });
      }
    }
    initPdfObserver() {
      if (!("IntersectionObserver" in window)) return;
      this.pdfObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const canvas = entry.target;
          this.requestPdfCanvas(canvas);
          this.pdfObserver.unobserve(canvas);
          canvas.removeAttribute("data-pdf-observed");
        });
      }, { rootMargin: "1200px" });
    }
    requestPdfCanvas(canvas) {
      const path = canvas.getAttribute("data-req-path");
      const id = canvas.id;
      if (path && id && !canvas.getAttribute("data-rendered") && !canvas.getAttribute("data-requested")) {
        window.renderPdfToCanvas(path, id);
      }
    }
    isPdfCanvasNearViewport(canvas) {
      const rect = canvas.getBoundingClientRect();
      return rect.bottom >= -PDF_RENDER_MARGIN && rect.top <= window.innerHeight + PDF_RENDER_MARGIN;
    }
    isPdfCanvasFarFromViewport(canvas) {
      const rect = canvas.getBoundingClientRect();
      return rect.bottom < -PDF_RELEASE_MARGIN || rect.top > window.innerHeight + PDF_RELEASE_MARGIN;
    }
    releasePdfCanvasBitmap(canvas) {
      if (canvas.getAttribute("data-rendered") !== "true" || canvas.getAttribute("data-pdf-released") === "true") return;
      const rect = canvas.getBoundingClientRect();
      if (rect.height > 0) {
        canvas.style.height = `${Math.ceil(rect.height)}px`;
      }
      canvas.width = 0;
      canvas.height = 0;
      canvas.removeAttribute("data-rendered");
      canvas.removeAttribute("data-requested");
      canvas.setAttribute("data-pdf-released", "true");
    }
    schedulePendingPdfRender() {
      if (this.pdfRenderTimer) clearTimeout(this.pdfRenderTimer);
      const run = () => {
        this.renderPendingPdfs();
        this.logDomStats("after renderPendingPdfs");
      };
      requestAnimationFrame(() => {
        requestAnimationFrame(run);
      });
      this.pdfRenderTimer = setTimeout(() => {
        this.pdfRenderTimer = null;
        run();
      }, 250);
    }
    renderPendingPdfs() {
      const pdfCanvases = document.querySelectorAll("canvas[data-req-path]");
      pdfCanvases.forEach((canvas) => {
        if (this.isPdfCanvasFarFromViewport(canvas)) {
          this.releasePdfCanvasBitmap(canvas);
        }
        if (canvas.getAttribute("data-rendered") || canvas.getAttribute("data-requested")) return;
        if (this.isPdfCanvasNearViewport(canvas)) {
          this.requestPdfCanvas(canvas);
          return;
        }
        if (this.pdfObserver) {
          if (!canvas.getAttribute("data-pdf-observed")) {
            canvas.setAttribute("data-pdf-observed", "true");
            this.pdfObserver.observe(canvas);
          }
        } else {
          this.requestPdfCanvas(canvas);
        }
      });
    }
    highlightTextInNode(rootElement, text) {
      if (!text || text.length < 3) return false;
      const walker = document.createTreeWalker(rootElement, NodeFilter.SHOW_TEXT, {
        acceptNode: (node2) => {
          if (node2.parentElement && node2.parentElement.closest(".katex")) return NodeFilter.FILTER_REJECT;
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
          const span = document.createElement("span");
          span.className = "highlight-word";
          range.surroundContents(span);
          setTimeout(() => {
            const parent = span.parentNode;
            if (parent) {
              parent.replaceChild(document.createTextNode(span.textContent), span);
              parent.normalize();
            }
          }, 2e3);
          return true;
        }
      }
      return false;
    }
    findTextOffsetInBlock(rootElement, text) {
      if (!text || text.length < 3) return null;
      const walker = document.createTreeWalker(rootElement, NodeFilter.SHOW_TEXT, {
        acceptNode: (node2) => {
          if (node2.parentElement && node2.parentElement.closest(".katex")) return NodeFilter.FILTER_REJECT;
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
          const rect = range.getBoundingClientRect();
          return rect.top;
        }
      }
      return null;
    }
  };
  var controller = new PreviewController();
})();
//# sourceMappingURL=webview-main.js.map
