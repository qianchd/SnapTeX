/// <reference types="mocha" />

import * as assert from 'assert';
import type { EditorView } from '@codemirror/view';
import { StandaloneHost } from '../../apps/standalone/src/app';
import type { BrowserWritableFileHandle } from '../../apps/standalone/src/browser-file-provider';
import { HostToPreviewCommand, PreviewToHostCommand, type HostToPreviewMessage } from '../preview-messages';

function normalizeEditorText(text: string): string {
    return text.replace(/\r\n?/g, '\n');
}

class TestEditorView {
    public selectionAnchor = -1;
    public scrollEffects = 0;
    public lastEffects: unknown;
    public scrollDOM = { scrollTop: 0, clientHeight: 100 };

    constructor(private text = '') {}

    get state() {
        return {
            doc: {
                length: this.text.length,
                toString: () => this.text
            }
        };
    }

    dispatch(update: { changes?: { from: number; to: number; insert: string }; selection?: { anchor: number }; effects?: unknown }) {
        if (update.changes) {
            const { from, to, insert } = update.changes;
            this.text = normalizeEditorText(`${this.text.slice(0, from)}${insert}${this.text.slice(to)}`);
        }
        if (update.selection) {
            this.selectionAnchor = update.selection.anchor;
        }
        if (update.effects) {
            this.lastEffects = update.effects;
            this.scrollEffects += 1;
        }
    }

    replaceText(text: string) {
        this.text = normalizeEditorText(text);
    }

    lineBlockAt(position: number) {
        return { top: position + 200, height: 20 };
    }

    requestMeasure(request: { read: (view: EditorView) => unknown; write?: (measure: unknown, view: EditorView) => void }) {
        const measure = request.read(this as unknown as EditorView);
        request.write?.(measure, this as unknown as EditorView);
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

const flushAsync = () => new Promise(resolve => setTimeout(resolve, 0));

function installWindow(messages: HostToPreviewMessage[]) {
    const testGlobal = globalThis as unknown as { window: unknown };
    const previousWindow = testGlobal.window;
    testGlobal.window = {
        location: { origin: 'http://snaptex.test' },
        snaptexPreviewMessageQueue: [],
        postMessage(message: HostToPreviewMessage) {
            messages.push(message);
        }
    } as unknown as Window;
    return () => {
        testGlobal.window = previousWindow;
    };
}

async function requestBlockHtml(host: StandaloneHost, messages: HostToPreviewMessage[], index = 0): Promise<string> {
    const id = `block-${messages.length}`;
    await host.handlePreviewMessage({ command: PreviewToHostCommand.RequestBlockHtml, id, index, hash: '' });
    const response = [...messages].reverse().find(message => message.command === HostToPreviewCommand.BlockHtml && message.id === id);
    assert.ok(response && response.command === HostToPreviewCommand.BlockHtml);
    return response.html ?? '';
}

suite('StandaloneHost', () => {
    test('switches active files while rendering from the project root', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        const written = new Map<string, string>();
        const host = new StandaloneHost(editor as unknown as EditorView);

        try {
            const rootPath = await host.loadProjectFiles([
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
            ]);
            assert.equal(rootPath, '/main.tex');

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            await host.openEditorFile('/chapter.tex');
            host.handleEditorUpdate();
            editor.replaceText('Updated included paragraph.');
            host.handleEditorUpdate();
            assert.equal(host.isDirty('/chapter.tex'), true);
            await host.renderCurrentText();
            const saveResult = await host.saveCurrentText();
            const html = await requestBlockHtml(host, messages);

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

    test('keeps opened files clean until the editor content changes', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        const host = new StandaloneHost(editor as unknown as EditorView);

        try {
            await host.loadProject([
                { path: '/main.tex', readText: async () => '\\input{chapter}\r\n' },
                { path: '/chapter.tex', readText: async () => 'Original\r\nchapter.' }
            ], '/main.tex');
            assert.equal(host.isDirty('/main.tex'), false);

            await host.openEditorFile('/chapter.tex');
            host.handleEditorUpdate();
            assert.equal(host.isDirty('/chapter.tex'), false);

            editor.replaceText('Changed chapter.');
            host.handleEditorUpdate();
            assert.equal(host.isDirty('/chapter.tex'), true);

            await host.saveCurrentText();
            assert.equal(host.isDirty('/chapter.tex'), false);
        } finally {
            restoreWindow();
        }
    });

    test('changes preview root without changing the active editor file', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        let stateChanges = 0;
        const host = new StandaloneHost(editor as unknown as EditorView, '/main.tex', () => undefined, () => {
            stateChanges += 1;
        });

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

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            await host.openEditorFile('/chapter.tex');
            editor.replaceText('Unsaved included paragraph.');
            host.handleEditorUpdate();
            const beforeRootChangeStateChanges = stateChanges;
            await host.setPreviewRoot('/appendix.tex');
            const appendixHtml = await requestBlockHtml(host, messages);

            assert.equal(host.getRootPath(), '/appendix.tex');
            assert.equal(host.getActivePath(), '/chapter.tex');
            assert.equal(host.isDirty('/chapter.tex'), true);
            assert.equal(stateChanges, beforeRootChangeStateChanges + 1);
            assert.match(appendixHtml, /Appendix root paragraph/);
            assert.doesNotMatch(appendixHtml, /Unsaved included paragraph/);

            await host.setPreviewRoot('/main.tex');
            assert.match(await requestBlockHtml(host, messages), /Unsaved included paragraph/);
        } finally {
            restoreWindow();
        }
    });

    test('reloads a project with fresh root, active file, and dirty state', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
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

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
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
            assert.match(await requestBlockHtml(host, messages), /New root paragraph/);
        } finally {
            restoreWindow();
        }
    });

    test('reports missing project dependencies', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
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

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            await host.renderCurrentText();
            await requestBlockHtml(host, messages);
            await host.handlePreviewMessage({ command: PreviewToHostCommand.RequestPdf, id: 'pdf-1', path: 'missing-doc.pdf' });

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

    test('syncs the active editor selection to the root preview', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
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
                    text: [
                        'Included first paragraph.',
                        '',
                        'Included second paragraph with \\textbf{sync anchor}.'
                    ].join('\n')
                }
            ], '/main.tex');

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            await host.openEditorFile('/chapter.tex');
            host.syncEditorSelection(2, 28, 'Included second paragraph with \\textbf{sync anchor}.');

            const response = [...messages].reverse().find(message => message.command === HostToPreviewCommand.ScrollToBlock);
            assert.ok(response && response.command === HostToPreviewCommand.ScrollToBlock);
            assert.equal(response.auto, true);
            assert.match(response.anchor ?? '', /sync anchor/);
            assert.doesNotMatch(response.anchor ?? '', /\\textbf/);
            assert.equal(typeof response.index, 'number');
            assert.equal(typeof response.ratio, 'number');

            await host.syncEditorSelection(2, 28, 'Included second paragraph with \\textbf{sync anchor}.', 0.5, false);
            const manualResponse = [...messages].reverse().find(message => message.command === HostToPreviewCommand.ScrollToBlock && message.auto === false);
            assert.ok(manualResponse && manualResponse.command === HostToPreviewCommand.ScrollToBlock);
        } finally {
            restoreWindow();
        }
    });

    test('applies standalone preview settings', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        let scheduledRenders = 0;
        const host = new StandaloneHost(editor as unknown as EditorView, '/main.tex', () => {
            scheduledRenders += 1;
        }, () => undefined, {
            livePreview: false,
            autoScrollSync: false,
            autoScrollDelayMs: 250,
            debugMemory: true,
            virtualMode: false
        });

        try {
            await host.loadProject([{
                path: '/main.tex',
                text: [
                    '\\begin{document}',
                    'Root paragraph.',
                    '\\end{document}'
                ].join('\n')
            }], '/main.tex');

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            const config = messages.find(message => message.command === HostToPreviewCommand.Config);
            assert.ok(config && config.command === HostToPreviewCommand.Config);
            assert.equal(config.config.autoScrollDelay, 250);
            assert.equal(config.config.debugMemory, true);
            assert.equal(config.config.virtualMode, false);

            editor.replaceText('Changed paragraph.');
            host.handleEditorUpdate();
            assert.equal(scheduledRenders, 0);

            host.syncEditorSelection(1, 0, 'Changed paragraph.');
            assert.equal(messages.some(message => message.command === HostToPreviewCommand.ScrollToBlock), false);

            host.updateSettings({ livePreview: true, autoScrollSync: true });
            host.handleEditorUpdate();
            assert.equal(scheduledRenders, 1);

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLayoutChanged });
            assert.equal(host.shouldSuppressEditorToPreview(), true);
        } finally {
            restoreWindow();
        }
    });

    test('reloads the current root when backend mode changes', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        const host = new StandaloneHost(editor as unknown as EditorView, '/main.tex', () => undefined, () => undefined, {
            livePreview: false,
            virtualMode: true,
            backendMode: 'legacy'
        });

        try {
            await host.loadProject([{
                path: '/main.tex',
                text: [
                    '\\begin{document}',
                    'Root paragraph.',
                    '\\end{document}'
                ].join('\n')
            }], '/main.tex');
            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            await flushAsync();
            const updateCount = messages.filter(message => message.command === HostToPreviewCommand.Update).length;

            host.updateSettings({ backendMode: 'ast(experimental)' });
            await flushAsync();
            const updates = messages.filter(message => message.command === HostToPreviewCommand.Update);
            const lastUpdate = updates[updates.length - 1];

            assert.equal(updates.length, updateCount + 1);
            assert.ok(lastUpdate && lastUpdate.command === HostToPreviewCommand.Update);
            assert.ok(lastUpdate.payload.type === 'full');
            assert.equal(lastUpdate.payload.resetPreviewState, true);

            host.updateSettings({ backendMode: 'legacy' });
            await flushAsync();
            const switchedBackUpdates = messages.filter(message => message.command === HostToPreviewCommand.Update);
            const switchedBackUpdate = switchedBackUpdates[switchedBackUpdates.length - 1];

            assert.equal(switchedBackUpdates.length, updateCount + 2);
            assert.ok(switchedBackUpdate && switchedBackUpdate.command === HostToPreviewCommand.Update);
            assert.ok(switchedBackUpdate.payload.type === 'full');
            assert.equal(switchedBackUpdate.payload.resetPreviewState, true);
        } finally {
            restoreWindow();
        }
    });

    test('syncs preview scroll positions back to the editor', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
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
                    text: [
                        'Included first paragraph.',
                        '',
                        'Included second paragraph with \\textbf{sync anchor}.'
                    ].join('\n')
                }
            ], '/main.tex');

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            await host.openEditorFile('/chapter.tex');
            host.syncEditorSelection(2, 28, 'Included second paragraph with \\textbf{sync anchor}.');
            const scroll = [...messages].reverse().find(message => message.command === HostToPreviewCommand.ScrollToBlock);
            assert.ok(scroll && scroll.command === HostToPreviewCommand.ScrollToBlock);

            await host.openEditorFile('/main.tex');
            await host.syncPreviewScroll(scroll.index, scroll.ratio);

            assert.equal(host.getActivePath(), '/chapter.tex');
            assert.ok(editor.scrollEffects > 0);
        } finally {
            restoreWindow();
        }
    });

    test('reveals preview double-click locations in the active editor', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        const host = new StandaloneHost(editor as unknown as EditorView);
        const chapterText = [
            'Included first paragraph.',
            '',
            'Included second paragraph with \\textbf{sync anchor}.'
        ].join('\n');

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
                    text: chapterText
                }
            ], '/main.tex');

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            await host.openEditorFile('/chapter.tex');
            host.syncEditorSelection(2, 28, 'Included second paragraph with \\textbf{sync anchor}.');
            const scroll = [...messages].reverse().find(message => message.command === HostToPreviewCommand.ScrollToBlock);
            assert.ok(scroll && scroll.command === HostToPreviewCommand.ScrollToBlock);

            await host.openEditorFile('/main.tex');
            await host.revealPreviewLocation(scroll.index, scroll.ratio, ['sync anchor'], 0.25);

            assert.equal(host.getActivePath(), '/chapter.tex');
            assert.equal(editor.selectionAnchor, chapterText.indexOf('Included second paragraph'));
            assert.equal(editor.scrollDOM.scrollTop, editor.selectionAnchor + 175);
            assert.ok(editor.lastEffects);
        } finally {
            restoreWindow();
        }
    });
});
