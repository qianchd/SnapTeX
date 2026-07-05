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

    test('fails clearly when the host bridge is missing', () => {
        (globalThis as { window?: unknown }).window = {};

        assert.throws(() => getPreviewBridge(), /host must install window\.snaptexPreviewBridge/);
    });
});
