/// <reference types="mocha" />

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ExtensionToWebviewCommand, isWebviewToExtensionMessage, WebviewToExtensionCommand } from '../webview-messages';
import { readWebviewRuntimeSource } from './test-helpers';

suite('Webview message contracts', () => {
    test('accepts well-formed webview messages', () => {
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
    });

    test('rejects malformed or unknown webview messages', () => {
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

    test('routes panel and webview code through shared command constants', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const panelSource = fs.readFileSync(path.join(repoRoot, 'src', 'panel.ts'), 'utf8');
        const extensionSource = fs.readFileSync(path.join(repoRoot, 'src', 'extension.ts'), 'utf8');
        const webviewSource = readWebviewRuntimeSource(repoRoot);

        assert.match(panelSource, /isWebviewToExtensionMessage\(message\)/);
        assert.match(panelSource, /assertNever\(message\)/);
        assert.match(extensionSource, /ExtensionToWebviewCommand\.ScrollToBlock/);
        assert.match(webviewSource, /WebviewToExtensionCommand\.WebviewLoaded/);
        assert.match(webviewSource, /WebviewToExtensionCommand\.RequestPdf/);
        assert.match(webviewSource, /ExtensionToWebviewCommand\.PdfUri/);
    });
});
