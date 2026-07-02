// @ts-nocheck
/* eslint-disable curly */

window.tikzJaxJsUri = document.body.dataset.tikzJaxJsUri || '';
    window.tikzJaxCssUri = document.body.dataset.tikzJaxCssUri || '';
    window.tikzJaxCssLoadPromise = null;
    window.tikzJaxLoadPromise = null;
    window.tikzJaxFailed = false;
const TIKZ_ACTIVE_RENDER_TIMEOUT_MS = 60000;
export const TIKZ_BATCH_RENDER_TIMEOUT_MS = 65000;
export const TIKZ_RENDER_DEBOUNCE_MS = 200;
const TIKZ_PENDING_SCRIPT_TYPE = 'text/snaptex-tikz';
const TIKZ_ACTIVE_SCRIPT_TYPE = 'text/tikz';
const TIKZ_PENDING_SCRIPT_SELECTOR = `script[type="${TIKZ_PENDING_SCRIPT_TYPE}"]`;
export const TIKZ_SCRIPT_SELECTOR = `${TIKZ_PENDING_SCRIPT_SELECTOR}, script[type="${TIKZ_ACTIVE_SCRIPT_TYPE}"]`;

/**
 * Webview-side TikZ integration.
 *
 * TikZ blocks are inserted as inert scripts first, then activated after the
 * shared TikZJax runtime has loaded. Container state is tracked separately so
 * stale previews can remain visible until replacement rendering settles.
 */
function restoreTikzScriptText(text) {
        return String(text || '').replace(/<\\\/script/gi, '</script');
    }
export function hasRenderedTikz(container) {
        return !!container.querySelector('svg[role="img"]:not(.tikz-stale-preview)');
    }

    function notifyTikzContainerSettled(container) {
        if (!container || !container.isConnected) return;
        container.dispatchEvent(new CustomEvent('snaptex-tikz-settled', { bubbles: true }));
    }

    function ensureTikzJaxCssLoaded() {
        if (window.tikzJaxCssLoadPromise) {
            return window.tikzJaxCssLoadPromise;
        }
        if (!window.tikzJaxCssUri || document.getElementById('tikzjax-fonts-css')) {
            return Promise.resolve();
        }

        window.tikzJaxCssLoadPromise = new Promise(resolve => {
            const link = document.createElement('link');
            link.id = 'tikzjax-fonts-css';
            link.rel = 'stylesheet';
            link.href = window.tikzJaxCssUri;
            link.onload = () => resolve();
            link.onerror = () => {
                console.warn('[SnapTeX] Failed to load TikZJax fonts CSS; continuing with fallback fonts.');
                resolve();
            };
            document.head.appendChild(link);
        });
        return window.tikzJaxCssLoadPromise;
    }

    window.ensureTikzJaxLoaded = function() {
        if (window.TikzJax) {
            return ensureTikzJaxCssLoaded();
        }
        if (window.tikzJaxFailed) {
            return Promise.reject(new Error('TikZJax is disabled after a previous load failure.'));
        }
        if (window.tikzJaxLoadPromise) {
            return window.tikzJaxLoadPromise;
        }

        window.tikzJaxLoadPromise = ensureTikzJaxCssLoaded().then(() => new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = window.tikzJaxJsUri;
            script.id = 'tikzjax-script';
            script.defer = true;
            script.onload = () => resolve();
            script.onerror = () => {
                window.tikzJaxFailed = true;
                window.tikzJaxLoadPromise = null;
                reject(new Error('Failed to load TikZJax.'));
            };
            document.head.appendChild(script);
        }));

        return window.tikzJaxLoadPromise;
    };

    window.addEventListener('unhandledrejection', event => {
        const message = String(event.reason?.message || event.reason || '');
        if (message.includes('Did not receive an init message') || message.includes('run-tex.js')) {
            window.tikzJaxFailed = true;
            window.failPendingTikzContainers('TikZ rendering failed.');
            console.warn('[SnapTeX] TikZJax worker failed; disabling TikZ rendering for this webview session.', event.reason);
        }
    });

    function getTikzContainerFromEvent(event) {
        const target = event.target;
        return target && target.closest ? target.closest('.tikz-container') : null;
    }
export function setTikzContainerState(container, state) {
        container.setAttribute('data-tikz-state', state);
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
            window.failTikzContainer(container, 'TikZ rendering timed out.');
        }, TIKZ_ACTIVE_RENDER_TIMEOUT_MS);
    }

    window.failTikzContainer = function(container, message) {
        if (!container || !container.isConnected) return;
        const state = container.getAttribute('data-tikz-state');
        const isActive = state === 'queued' || state === 'rendering' || state === 'stale';
        if (hasRenderedTikz(container) && !isActive) return;

        clearTikzRenderTimer(container);
        setTikzContainerState(container, 'failed');
        const errorEl = document.createElement('div');
        errorEl.className = 'tikz-error';
        errorEl.style.cssText = 'padding: 12px; color: #8a1f11; background: #fff3f0; border: 1px solid #f0c6bd; font: 12px sans-serif;';
        errorEl.textContent = message;
        container.replaceChildren(errorEl);
        notifyTikzContainerSettled(container);
    };

    window.failPendingTikzContainers = function(message) {
        document.querySelectorAll('.tikz-container').forEach(container => {
            window.failTikzContainer(container, message);
        });
    };

    window.watchPendingTikzContainers = function(root = document, containers = null) {
        const targets = containers || Array.from(root.querySelectorAll('.tikz-container'));
        targets.forEach(container => {
            if (hasRenderedTikz(container) || container.getAttribute('data-tikz-state') === 'failed') return;

            setTikzContainerState(container, 'queued');
        });
    };

    window.activatePendingTikzScripts = function(root = document, containers = null) {
        const pendingScripts = containers
            ? containers.flatMap(container => Array.from(container.querySelectorAll(TIKZ_PENDING_SCRIPT_SELECTOR)))
            : Array.from(root.querySelectorAll(TIKZ_PENDING_SCRIPT_SELECTOR));
        pendingScripts.forEach(script => {
            if (!script.isConnected) return;

            const activeScript = document.createElement('script');
            for (const attr of script.attributes) {
                if (attr.name !== 'type') {
                    activeScript.setAttribute(attr.name, attr.value);
                }
            }
            activeScript.type = TIKZ_ACTIVE_SCRIPT_TYPE;
            activeScript.textContent = restoreTikzScriptText(script.textContent);
            script.replaceWith(activeScript);
        });
        return pendingScripts.length;
    };

    document.addEventListener('tikzjax-tex-input', event => {
        const container = getTikzContainerFromEvent(event);
        if (!container) return;

        setTikzContainerState(container, 'rendering');
        armTikzRenderTimer(container);
    });

    document.addEventListener('tikzjax-load-finished', event => {
        const container = getTikzContainerFromEvent(event);
        if (!container) return;

        clearTikzRenderTimer(container);
        container.querySelectorAll('.tikz-stale-preview').forEach(preview => preview.remove());
        setTikzContainerState(container, 'rendered');
        notifyTikzContainerSettled(container);
    });

    document.addEventListener('tikzjax-load-failed', event => {
        const container = getTikzContainerFromEvent(event);
        if (!container) return;

        const message = event.detail?.message || 'TikZ rendering failed.';
        window.failTikzContainer(container, message);
    });

