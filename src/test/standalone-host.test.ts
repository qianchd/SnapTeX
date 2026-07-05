/// <reference types="mocha" />

import * as assert from 'assert';
import type { EditorView } from '@codemirror/view';
import { StandaloneHost } from '../../apps/standalone/src/app';
import type { BrowserWritableFileHandle } from '../../apps/standalone/src/browser-file-provider';
import { ExtensionToWebviewCommand, WebviewToExtensionCommand, type ExtensionToWebviewMessage } from '../webview-messages';

class TestEditorView {
    constructor(private text = '') {}

    get state() {
        return {
            doc: {
                length: this.text.length,
                toString: () => this.text
            }
        };
    }

    dispatch(update: { changes: { from: number; to: number; insert: string } }) {
        const { from, to, insert } = update.changes;
        this.text = `${this.text.slice(0, from)}${insert}${this.text.slice(to)}`;
    }

    replaceText(text: string) {
        this.text = text;
    }
}

function createWritableHandle(writeText: (text: string) => void): BrowserWritableFileHandle {
    return {
        async createWritable() {
            return {
                write: writeText,
                close() {}
            };
        }
    };
}

function installWindow(messages: ExtensionToWebviewMessage[]) {
    const testGlobal = globalThis as unknown as { window: unknown };
    const previousWindow = testGlobal.window;
    testGlobal.window = {
        location: { origin: 'http://snaptex.test' },
        snaptexPreviewMessageQueue: [],
        postMessage(message: ExtensionToWebviewMessage) {
            messages.push(message);
        }
    } as unknown as Window;
    return () => {
        testGlobal.window = previousWindow;
    };
}

function requestBlockHtml(host: StandaloneHost, messages: ExtensionToWebviewMessage[], index = 0): string {
    const id = `block-${messages.length}`;
    host.handlePreviewMessage({ command: WebviewToExtensionCommand.RequestBlockHtml, id, index, hash: '' });
    const response = [...messages].reverse().find(message => message.command === ExtensionToWebviewCommand.BlockHtml && message.id === id);
    assert.ok(response && response.command === ExtensionToWebviewCommand.BlockHtml);
    return response.html ?? '';
}

suite('StandaloneHost', () => {
    test('switches active files while rendering from the project root', async () => {
        const editor = new TestEditorView();
        const messages: ExtensionToWebviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        const written = new Map<string, string>();
        const host = new StandaloneHost(editor as unknown as EditorView);

        try {
            await host.loadProject([
                {
                    path: '/main.tex',
                    text: [
                        '\\begin{document}',
                        'Root paragraph.',
                        '\\input{chapter}',
                        '\\end{document}'
                    ].join('\n'),
                    handle: createWritableHandle(text => written.set('/main.tex', text))
                },
                {
                    path: '/chapter.tex',
                    text: 'Original included paragraph.',
                    handle: createWritableHandle(text => written.set('/chapter.tex', text))
                }
            ], '/main.tex');

            host.handlePreviewMessage({ command: WebviewToExtensionCommand.WebviewLoaded });
            await host.openEditorFile('/chapter.tex');
            editor.replaceText('Updated included paragraph.');
            await host.renderCurrentText();
            const saveResult = await host.saveCurrentText();
            const html = requestBlockHtml(host, messages);

            assert.equal(host.getRootPath(), '/main.tex');
            assert.equal(host.getActivePath(), '/chapter.tex');
            assert.equal(saveResult.path, '/chapter.tex');
            assert.equal(written.get('/chapter.tex'), 'Updated included paragraph.');
            assert.match(html, /Updated included paragraph/);
            assert.match(html, /Root paragraph/);
        } finally {
            restoreWindow();
        }
    });

    test('changes preview root without changing the active editor file', async () => {
        const editor = new TestEditorView();
        const messages: ExtensionToWebviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        const host = new StandaloneHost(editor as unknown as EditorView);

        try {
            await host.loadProject([
                {
                    path: '/main.tex',
                    text: [
                        '\\begin{document}',
                        'Root paragraph.',
                        '\\input{chapter}',
                        '\\end{document}'
                    ].join('\n')
                },
                {
                    path: '/chapter.tex',
                    text: 'Original included paragraph.'
                },
                {
                    path: '/appendix.tex',
                    text: [
                        '\\begin{document}',
                        'Appendix root paragraph.',
                        '\\end{document}'
                    ].join('\n')
                }
            ], '/main.tex');

            host.handlePreviewMessage({ command: WebviewToExtensionCommand.WebviewLoaded });
            await host.openEditorFile('/chapter.tex');
            editor.replaceText('Unsaved included paragraph.');
            await host.setPreviewRoot('/appendix.tex');
            const appendixHtml = requestBlockHtml(host, messages);

            assert.equal(host.getRootPath(), '/appendix.tex');
            assert.equal(host.getActivePath(), '/chapter.tex');
            assert.match(appendixHtml, /Appendix root paragraph/);
            assert.doesNotMatch(appendixHtml, /Unsaved included paragraph/);

            await host.setPreviewRoot('/main.tex');
            assert.match(requestBlockHtml(host, messages), /Unsaved included paragraph/);
        } finally {
            restoreWindow();
        }
    });
});
