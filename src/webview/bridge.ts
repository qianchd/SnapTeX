import type { WebviewToExtensionMessage } from '../webview-messages';

export interface PreviewBridge {
    postMessage(message: WebviewToExtensionMessage): void;
}

declare global {
    interface Window {
        snaptexPreviewBridge?: PreviewBridge;
    }
}

export function getPreviewBridge(): PreviewBridge {
    if (window.snaptexPreviewBridge) {
        return window.snaptexPreviewBridge;
    }
    throw new Error('SnapTeX preview bridge is unavailable. The host must install window.snaptexPreviewBridge before loading the preview runtime.');
}
