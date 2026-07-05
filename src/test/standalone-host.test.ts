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
            host.handleEditorUpdate();
            editor.replaceText('Updated included paragraph.');
            host.handleEditorUpdate();
            assert.equal(host.isDirty('/chapter.tex'), true);
            await host.renderCurrentText();
            const saveResult = await host.saveCurrentText();
            const html = requestBlockHtml(host, messages);

            assert.equal(host.getRootPath(), '/main.tex');
            assert.equal(host.getActivePath(), '/chapter.tex');
            assert.equal(saveResult.path, '/chapter.tex');
            assert.equal(written.get('/chapter.tex'), 'Updated included paragraph.');
            assert.equal(host.isDirty('/chapter.tex'), false);
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
            assert.equal(host.isDirty('/chapter.tex'), true);
            assert.match(appendixHtml, /Appendix root paragraph/);
            assert.doesNotMatch(appendixHtml, /Unsaved included paragraph/);

            await host.setPreviewRoot('/main.tex');
            assert.match(requestBlockHtml(host, messages), /Unsaved included paragraph/);
        } finally {
            restoreWindow();
        }
    });

    test('reloads a project with fresh root, active file, and dirty state', async () => {
        const editor = new TestEditorView();
        const messages: ExtensionToWebviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        const host = new StandaloneHost(editor as unknown as EditorView);

        try {
            await host.loadProject([
                {
                    path: '/old/main.tex',
                    text: [
                        '\\begin{document}',
                        '\\input{chapter}',
                        '\\end{document}'
                    ].join('\n')
                },
                {
                    path: '/old/chapter.tex',
                    text: 'Old included paragraph.'
                }
            ], '/old/main.tex');

            host.handlePreviewMessage({ command: WebviewToExtensionCommand.WebviewLoaded });
            await host.openEditorFile('/old/chapter.tex');
            host.handleEditorUpdate();
            editor.replaceText('Unsaved old paragraph.');
            host.handleEditorUpdate();
            assert.equal(host.isDirty('/old/chapter.tex'), true);

            await host.loadProject([
                {
                    path: '/new/main.tex',
                    text: [
                        '\\begin{document}',
                        'New root paragraph.',
                        '\\end{document}'
                    ].join('\n')
                }
            ], '/new/main.tex');

            assert.equal(host.getRootPath(), '/new/main.tex');
            assert.equal(host.getActivePath(), '/new/main.tex');
            assert.equal(host.isDirty('/old/chapter.tex'), false);
            assert.equal(host.isDirty('/new/main.tex'), false);
            assert.match(requestBlockHtml(host, messages), /New root paragraph/);
        } finally {
            restoreWindow();
        }
    });

    test('reports missing project dependencies', async () => {
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
                        '\\input{missing-chapter}',
                        '\\begin{figure}',
                        '\\includegraphics{missing-image.png}',
                        '\\includegraphics{missing-doc.pdf}',
                        '\\end{figure}',
                        '\\bibliography{missing-refs}',
                        '\\end{document}'
                    ].join('\n')
                }
            ], '/main.tex');

            host.handlePreviewMessage({ command: WebviewToExtensionCommand.WebviewLoaded });
            await host.renderCurrentText();
            requestBlockHtml(host, messages);
            host.handlePreviewMessage({ command: WebviewToExtensionCommand.RequestPdf, id: 'pdf-1', path: 'missing-doc.pdf' });

            assert.deepEqual(host.getDiagnostics(), [
                'Missing input file: /missing-chapter.tex',
                'Missing bibliography file: /missing-refs.bib',
                'Missing image: missing-image.png',
                'Missing PDF: missing-doc.pdf'
            ]);
        } finally {
            restoreWindow();
        }
    });
});
