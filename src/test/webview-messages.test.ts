/// <reference types="mocha" />

import * as assert from 'assert';
import { isWebviewToExtensionMessage, WebviewToExtensionCommand } from '../webview-messages';

suite('Webview message contracts', () => {
    test('validates accepted and rejected webview messages', () => {
        assert.equal(isWebviewToExtensionMessage({ command: WebviewToExtensionCommand.WebviewLoaded }), true);
        assert.equal(isWebviewToExtensionMessage({
            command: WebviewToExtensionCommand.RevealLine,
            index: 2,
            ratio: 0.5,
            anchor: 'word',
            viewRatio: 0.4
        }), true);
        assert.equal(isWebviewToExtensionMessage({
            command: WebviewToExtensionCommand.RequestBlockHtml,
            id: 'block-1',
            index: 3,
            hash: 'abc'
        }), true);
        assert.equal(isWebviewToExtensionMessage({
            command: WebviewToExtensionCommand.RequestPdf,
            id: 'pdf-1',
            path: 'figures/a.pdf'
        }), true);

        assert.equal(isWebviewToExtensionMessage(null), false);
        assert.equal(isWebviewToExtensionMessage({ command: 'unknown' }), false);
        assert.equal(isWebviewToExtensionMessage({
            command: WebviewToExtensionCommand.RevealLine,
            index: '2',
            ratio: 0.5
        }), false);
        assert.equal(isWebviewToExtensionMessage({
            command: WebviewToExtensionCommand.RequestPdf,
            id: 'pdf-1',
            path: 42
        }), false);
    });

});
