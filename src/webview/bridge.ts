import type { WebviewToExtensionMessage } from '../webview-messages';

export interface PreviewBridge {
    postMessage(message: WebviewToExtensionMessage): void;
}

declare global {
    interface Window {
        acquireVsCodeApi?: () => PreviewBridge;
        snaptexPreviewBridge?: PreviewBridge;
    }
}

export function getPreviewBridge(): PreviewBridge {
    if (window.snaptexPreviewBridge) {
        return window.snaptexPreviewBridge;
    }
    if (typeof window.acquireVsCodeApi === 'function') {
        const bridge = window.acquireVsCodeApi();
        window.snaptexPreviewBridge = bridge;
        return bridge;
    }
    throw new Error('SnapTeX preview bridge is unavailable.');
}
