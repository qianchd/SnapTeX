/// <reference types="mocha" />

import * as assert from 'assert';
import { getPreviewBridge, type PreviewBridge } from '../webview/bridge';
import { WebviewToExtensionCommand, type WebviewToExtensionMessage } from '../webview-messages';

suite('Preview bridge', () => {
    let previousWindow: unknown;

    setup(() => {
        previousWindow = (globalThis as { window?: unknown }).window;
    });

    teardown(() => {
        if (previousWindow === undefined) {
            delete (globalThis as { window?: unknown }).window;
        } else {
            (globalThis as { window?: unknown }).window = previousWindow;
        }
    });

    test('uses a host-provided bridge when available', () => {
        const sent: WebviewToExtensionMessage[] = [];
        const bridge: PreviewBridge = { postMessage: message => sent.push(message) };
        (globalThis as { window?: unknown }).window = { snaptexPreviewBridge: bridge };

        getPreviewBridge().postMessage({ command: WebviewToExtensionCommand.WebviewLoaded });

        assert.deepEqual(sent, [{ command: WebviewToExtensionCommand.WebviewLoaded }]);
    });

    test('falls back to the VS Code API once and caches it', () => {
        let acquireCalls = 0;
        const bridge: PreviewBridge = { postMessage: () => undefined };
        const fakeWindow: {
            acquireVsCodeApi: () => PreviewBridge;
            snaptexPreviewBridge?: PreviewBridge;
            snaptexVsCodeApi?: PreviewBridge;
        } = {
            acquireVsCodeApi: () => {
                acquireCalls += 1;
                return bridge;
            }
        };
        (globalThis as { window?: unknown }).window = fakeWindow;

        assert.strictEqual(getPreviewBridge(), bridge);
        assert.strictEqual(getPreviewBridge(), bridge);
        assert.equal(acquireCalls, 1);
        assert.strictEqual(fakeWindow.snaptexVsCodeApi, bridge);
        assert.strictEqual(fakeWindow.snaptexPreviewBridge, bridge);
    });
});
