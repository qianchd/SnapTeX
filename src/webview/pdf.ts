// @ts-nocheck
/* eslint-disable curly */
import { ExtensionToWebviewCommand, WebviewToExtensionCommand } from '../webview-messages';

const vscode = window.snaptexVsCodeApi || acquireVsCodeApi();
    window.snaptexVsCodeApi = vscode;
    const pdfJsUri = document.body.dataset.pdfJsUri || '';
    const pdfWorkerUri = document.body.dataset.pdfWorkerUri || '';
    let pdfjsLib = null;
    let pdfRuntimeReady = null;

    /**
     * Handles PDF.js loading and canvas rendering inside the webview.
     *
     * The extension host validates paths and returns webview-safe URIs; this
     * module only consumes those URIs and paints the first page into canvases.
     */
    function ensurePdfRuntimeReady() {
        if (!pdfRuntimeReady) {
            pdfRuntimeReady = import(pdfJsUri).then(module => {
                pdfjsLib = module;
                pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUri;
                return setupPdfWorker();
            });
        }
        return pdfRuntimeReady;
    }

    async function setupPdfWorker() {
        if (!('Worker' in window) || !('fetch' in window) || !('Blob' in window) || !URL.createObjectURL) {
            return;
        }

        let workerBlobUrl = null;
        try {
            const response = await fetch(pdfWorkerUri);
            if (!response.ok) {
                throw new Error(`PDF worker fetch failed: ${response.status}`);
            }

            const workerCode = await response.text();
            workerBlobUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
            const worker = new Worker(workerBlobUrl, { type: 'module' });
            pdfjsLib.GlobalWorkerOptions.workerPort = worker;

            window.addEventListener('unload', () => {
                pdfjsLib.GlobalWorkerOptions.workerPort = null;
                worker.terminate();
                URL.revokeObjectURL(workerBlobUrl);
            }, { once: true });
        } catch (error) {
            if (workerBlobUrl) {
                URL.revokeObjectURL(workerBlobUrl);
            }
            console.warn('[SnapTeX] PDF worker blob setup failed; falling back to PDF.js workerSrc.', error);
        }
    }

    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.command === ExtensionToWebviewCommand.PdfUri) {
            if (msg.error || !msg.uri) {
                renderPdfError(msg.id, msg.error || 'Error loading PDF');
            } else {
                renderPdfFromUrl(msg.id, msg.uri);
            }
        }
    });

    function renderPdfError(canvasId, message) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        canvas.width = Math.max(canvas.width, 360);
        canvas.height = Math.max(canvas.height, 90);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = '12px sans-serif';
        ctx.fillText(message, 10, 50);
        markPdfRendered(canvas);
    }

    function markPdfRendered(canvas) {
        canvas.setAttribute('data-rendered', 'true');
        canvas.removeAttribute('data-requested');
        canvas.removeAttribute('data-pdf-released');
        canvas.style.height = '';
    }

    async function renderPdfDocument(canvas, loadingTask) {
        let pdfDocument = null;
        try {
            pdfDocument = await loadingTask.promise;

            const page = await pdfDocument.getPage(1);
            const scale = 2;
            const viewport = page.getViewport({ scale: scale });
            if (canvas.width !== viewport.width || canvas.height !== viewport.height) {
                canvas.height = viewport.height;
                canvas.width = viewport.width;
            }
            const context = canvas.getContext('2d');
            if (!context) return;
            await page.render({ canvasContext: context, viewport: viewport }).promise;

            markPdfRendered(canvas);

            page.cleanup();
        } finally {
            if (pdfDocument) {
                pdfDocument.destroy();
            }
        }
    }

    async function renderPdfFromUrl(canvasId, pdfUri) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;

        try {
            await ensurePdfRuntimeReady();
            await renderPdfDocument(canvas, pdfjsLib.getDocument({
                url: pdfUri,
                disableRange: true,
                disableStream: true,
                disableAutoFetch: true
            }));
        } catch (error) {
            console.error('PDF URI render error:', error);
            canvas.removeAttribute('data-requested');
            renderPdfError(canvasId, 'Error loading PDF');
        }
    }

    const realRequestPdf = (path, canvasId) => {
        const canvas = document.getElementById(canvasId);
        if (!canvas || canvas.getAttribute('data-requested') === 'true') return;

        canvas.setAttribute('data-requested', 'true');

        vscode.postMessage({
            command: WebviewToExtensionCommand.RequestPdf,
            id: canvasId,
            path: path
        });
    };

    if (window.pdfReqQueue && window.pdfReqQueue.length > 0) {
        console.log(`[SnapTeX] Processing ${window.pdfReqQueue.length} queued PDF requests.`);
        window.pdfReqQueue.forEach(req => realRequestPdf(req.path, req.canvasId));
    }

    window.renderPdfToCanvas = realRequestPdf;

