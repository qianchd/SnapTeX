/// <reference types="mocha" />

import * as assert from 'assert';
import { isPreviewToHostMessage, PreviewToHostCommand } from '../preview-messages';

suite('Preview message contracts', () => {
    test('validates accepted and rejected preview messages', () => {
        assert.equal(isPreviewToHostMessage({ command: PreviewToHostCommand.PreviewLoaded }), true);
        assert.equal(isPreviewToHostMessage({
            command: PreviewToHostCommand.RevealLine,
            index: 2,
            ratio: 0.5,
            anchors: ['nearby context word', 'word'],
            viewRatio: 0.4
        }), true);
        assert.equal(isPreviewToHostMessage({
            command: PreviewToHostCommand.RequestBlockHtml,
            id: 'block-1',
            index: 3,
            hash: 'abc'
        }), true);
        assert.equal(isPreviewToHostMessage({
            command: PreviewToHostCommand.RequestPdf,
            id: 'pdf-1',
            path: 'figures/a.pdf'
        }), true);

        assert.equal(isPreviewToHostMessage(null), false);
        assert.equal(isPreviewToHostMessage({ command: 'unknown' }), false);
        assert.equal(isPreviewToHostMessage({
            command: PreviewToHostCommand.RevealLine,
            index: '2',
            ratio: 0.5
        }), false);
        assert.equal(isPreviewToHostMessage({
            command: PreviewToHostCommand.RequestPdf,
            id: 'pdf-1',
            path: 42
        }), false);
    });

});
