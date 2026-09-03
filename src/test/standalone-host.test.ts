/// <reference types="mocha" />

import * as assert from 'assert';
import type { EditorView } from '@codemirror/view';
import { StandaloneHost } from '../../apps/standalone/src/app';
import { ProjectWriteConflictError, type BrowserProjectTextChange } from '../../apps/standalone/src/browser-project';
import { HostToPreviewCommand, PreviewToHostCommand, type HostToPreviewMessage } from '../preview-messages';

function normalizeEditorText(text: string): string {
    return text.replace(/\r\n?/g, '\n');
}

class TestEditorView {
    public selectionAnchor = -1;
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
    await host.handlePreviewMessage({
        command: PreviewToHostCommand.RequestBlockHtml,
        requests: [{ id, index, hash: '' }]
    });
    const response = [...messages].reverse().find(message => message.command === HostToPreviewCommand.BlockHtml && message.id === id);
    assert.ok(response && response.command === HostToPreviewCommand.BlockHtml);
    return response.html ?? '';
}

suite('StandaloneHost', () => {
    test('merges remote edits against the saved text and reports overlapping changes', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        let receiveChange: ((change: BrowserProjectTextChange) => Promise<void> | void) | undefined;
        const host = new StandaloneHost(editor as unknown as EditorView);

        try {
            await host.loadProject({
                files: [{ path: '/main.tex', text: 'First\nMiddle\nLast' }],
                rootPath: '/main.tex',
                watchTextFiles: onChange => {
                    receiveChange = onChange;
                    return () => undefined;
                }
            });
            editor.replaceText('Local first\nMiddle\nLast');
            host.handleEditorUpdate();

            await receiveChange?.({ path: '/main.tex', text: 'First\nMiddle\nRemote last' });
            assert.equal(editor.state.doc.toString(), 'Local first\nMiddle\nRemote last');
            assert.equal(host.isDirty('/main.tex'), true);
            assert.deepEqual(host.getDiagnostics(), []);

            await receiveChange?.({ path: '/main.tex', text: 'Remote first\nMiddle\nRemote last' });
            assert.match(editor.state.doc.toString(), /<<<<<<< LOCAL[\s\S]*Remote first[\s\S]*>>>>>>> REMOTE/);
            assert.match(host.getDiagnostics().join('\n'), /conflict markers/i);
        } finally {
            restoreWindow();
        }
    });

    test('merges and retries a save rejected after a concurrent remote edit', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        const writes: string[] = [];
        let firstWrite = true;
        const host = new StandaloneHost(editor as unknown as EditorView);

        try {
            await host.loadProject({ files: [{
                path: '/main.tex',
                text: 'First\nMiddle\nLast',
                writeText: async text => {
                    if (firstWrite) {
                        firstWrite = false;
                        throw new ProjectWriteConflictError('/main.tex', 'First\nMiddle\nRemote last');
                    }
                    writes.push(text);
                }
            }], rootPath: '/main.tex' });
            editor.replaceText('Local first\nMiddle\nLast');
            host.handleEditorUpdate();

            await host.saveCurrentText();
            assert.deepEqual(writes, ['Local first\nMiddle\nRemote last']);
            assert.equal(host.isDirty('/main.tex'), false);
        } finally {
            restoreWindow();
        }
    });

    test('creates and deletes project text files through injected project operations', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        const created: string[] = [];
        const deleted: string[] = [];
        const host = new StandaloneHost(editor as unknown as EditorView);

        try {
            await host.loadProject({ files: [
                { path: '/main.tex', text: '\\begin{document}\n\\input{sections/notes}\n\\end{document}' }
            ], rootPath: '/main.tex', operations: {
                createTextFile: async path => {
                    created.push(path);
                    return { path, text: '' };
                },
                deleteFile: async path => { deleted.push(path); }
            }});

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            assert.match(host.getDiagnostics().join('\n'), /Missing input file/);
            await host.createTextFile('/sections/notes.tex');
            assert.deepEqual(created, ['/sections/notes.tex']);
            assert.equal(host.getActivePath(), '/sections/notes.tex');
            assert.ok(host.getProjectTextPaths().includes('/sections/notes.tex'));
            assert.deepEqual(host.getDiagnostics(), []);

            await host.deleteTextFile('/sections/notes.tex');
            assert.deepEqual(deleted, ['/sections/notes.tex']);
            assert.equal(host.getActivePath(), '/main.tex');
            assert.ok(!host.getProjectTextPaths().includes('/sections/notes.tex'));
            await assert.rejects(() => host.deleteTextFile('/main.tex'), /preview root/i);
            await assert.rejects(() => host.createTextFile('/figure.png'), /text file/i);
        } finally {
            restoreWindow();
        }
    });

    test('switches active files while rendering from the project root', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        const written = new Map<string, string>();
        const host = new StandaloneHost(editor as unknown as EditorView);

        try {
            await host.loadProject({ files: [
                {
                    path: '/main.tex',
                    text: [
                        '\\begin{document}',
                        'Root paragraph.',
                        '\\input{chapter}',
                        '\\end{document}'
                    ].join('\n'),
                    writeText: text => { written.set('/main.tex', text); }
                },
                {
                    path: '/chapter.tex',
                    text: 'Original included paragraph.',
                    writeText: text => { written.set('/chapter.tex', text); }
                },
                {
                    path: '/unreadable.tex',
                    readText: async () => { throw new Error('Permission denied'); }
                }
            ]});
            assert.equal(host.getRootPath(), '/main.tex');

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            await assert.rejects(() => host.openEditorFile('/unreadable.tex'), /Permission denied/);
            assert.equal(host.getActivePath(), '/main.tex');
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

    test('renders batched virtual blocks through the host pipeline', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        const host = new StandaloneHost(editor as unknown as EditorView);

        try {
            await host.loadProject({ files: [{
                path: '/main.tex',
                text: '\\begin{document}\nFirst paragraph.\n\nSecond paragraph.\n\\end{document}'
            }], rootPath: '/main.tex' });
            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            await flushAsync();
            messages.length = 0;

            await host.handlePreviewMessage({
                command: PreviewToHostCommand.RequestBlockHtml,
                requests: [
                    { id: 'batch-0', index: 0, hash: '' },
                    { id: 'batch-1', index: 1, hash: '' }
                ]
            });

            const responses = messages.filter(message => message.command === HostToPreviewCommand.BlockHtml);
            assert.deepEqual(responses.map(response => response.id), ['batch-0', 'batch-1']);
            assert.match(responses[0]?.html ?? '', /First paragraph/);
            assert.match(responses[1]?.html ?? '', /Second paragraph/);
        } finally {
            restoreWindow();
        }
    });

    test('keeps opened files clean until the editor content changes', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        const host = new StandaloneHost(editor as unknown as EditorView);
        let persistedText = '';

        try {
            await host.loadProject({ files: [
                { path: '/main.tex', readText: async () => '\\input{chapter}\r\n' },
                {
                    path: '/chapter.tex',
                    readText: async () => 'Original\r\nchapter.',
                    writeText: text => { persistedText = text; }
                }
            ], rootPath: '/main.tex' });
            assert.equal(host.isDirty('/main.tex'), false);

            await host.openEditorFile('/chapter.tex');
            host.handleEditorUpdate();
            assert.equal(host.isDirty('/chapter.tex'), false);

            editor.replaceText('Changed chapter.');
            host.handleEditorUpdate();
            assert.equal(host.isDirty('/chapter.tex'), true);

            const result = await host.saveCurrentText();
            assert.equal(result.wroteToSource, true);
            assert.equal(persistedText, 'Changed chapter.');
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
            await host.loadProject({ files: [
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
            ], rootPath: '/main.tex' });

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
            await host.loadProject({ files: [
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
            ], rootPath: '/old/main.tex' });

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            await host.openEditorFile('/old/chapter.tex');
            host.handleEditorUpdate();
            editor.replaceText('Unsaved old paragraph.');
            host.handleEditorUpdate();
            assert.equal(host.isDirty('/old/chapter.tex'), true);

            await host.loadProject({ files: [
                {
                    path: '/new/main.tex',
                    text: [
                        '\\begin{document}',
                        'New root paragraph.',
                        '\\end{document}'
                    ].join('\n')
                }
            ], rootPath: '/new/main.tex' });

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
            await host.loadProject({ files: [
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
            ], rootPath: '/main.tex' });

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
            await host.loadProject({ files: [
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
            ], rootPath: '/main.tex' });

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

            host.setPreviewVisible(false);
            const messageCount = messages.length;
            host.syncEditorSelection(2, 28);
            assert.equal(messages.length, messageCount);
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
            virtualMode: false,
            fontSize: '18px',
            lineHeight: '1.5',
            contentMaxWidth: '800px',
            fontFamily: 'Arial, sans-serif'
        });

        try {
            await host.loadProject({ files: [{
                path: '/main.tex',
                text: [
                    '\\begin{document}',
                    'Root paragraph.',
                    '\\end{document}'
                ].join('\n')
            }], rootPath: '/main.tex' });

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            const config = messages.find(message => message.command === HostToPreviewCommand.Config);
            assert.ok(config && config.command === HostToPreviewCommand.Config);
            assert.equal(config.config.autoScrollDelay, 250);
            assert.equal(config.config.debugMemory, true);
            assert.equal(config.config.virtualMode, false);
            assert.equal(config.config.previewLayout, 'paged');
            assert.deepEqual(config.config.style, {
                fontSize: '18px',
                lineHeight: '1.5',
                contentMaxWidth: '800px',
                fontFamily: 'Arial, sans-serif'
            });

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
            await host.loadProject({ files: [{
                path: '/main.tex',
                text: [
                    '\\begin{document}',
                    'Root paragraph.',
                    '\\end{document}'
                ].join('\n')
            }], rootPath: '/main.tex' });
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
        let cancelledEditorSyncs = 0;
        let writes = 0;
        const host = new StandaloneHost(
            editor as unknown as EditorView,
            '/main.tex',
            undefined,
            undefined,
            {},
            () => { cancelledEditorSyncs += 1; }
        );

        try {
            await host.loadProject({ files: [
                {
                    path: '/main.tex',
                    text: [
                        '\\begin{document}',
                        'Root paragraph.',
                        '\\input{chapter}',
                        '\\end{document}'
                    ].join('\n'),
                    writeText: () => { writes += 1; }
                },
                {
                    path: '/chapter.tex',
                    text: [
                        'Included first paragraph.',
                        '',
                        'Included second paragraph with \\textbf{sync anchor}.'
                    ].join('\n'),
                    writeText: () => { writes += 1; }
                }
            ], rootPath: '/main.tex', autosave: true });

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            await host.openEditorFile('/chapter.tex');
            host.syncEditorSelection(2, 28, 'Included second paragraph with \\textbf{sync anchor}.');
            const scroll = [...messages].reverse().find(message => message.command === HostToPreviewCommand.ScrollToBlock);
            assert.ok(scroll && scroll.command === HostToPreviewCommand.ScrollToBlock);

            await host.openEditorFile('/main.tex');
            const updateCount = messages.filter(message => message.command === HostToPreviewCommand.Update).length;
            await host.syncPreviewScroll(scroll.index, scroll.ratio);

            assert.equal(host.getActivePath(), '/chapter.tex');
            assert.equal(messages.filter(message => message.command === HostToPreviewCommand.Update).length, updateCount);
            assert.ok(editor.scrollDOM.scrollTop > 0);
            assert.equal(cancelledEditorSyncs, 1);
            assert.equal(writes, 0);

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLayoutChanged });
            editor.scrollDOM.scrollTop = 0;
            await host.syncPreviewScroll(scroll.index, scroll.ratio);
            assert.equal(editor.scrollDOM.scrollTop, 0);
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
            await host.loadProject({ files: [
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
            ], rootPath: '/main.tex' });

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            await host.openEditorFile('/chapter.tex');
            host.syncEditorSelection(2, 28, 'Included second paragraph with \\textbf{sync anchor}.');
            const scroll = [...messages].reverse().find(message => message.command === HostToPreviewCommand.ScrollToBlock);
            assert.ok(scroll && scroll.command === HostToPreviewCommand.ScrollToBlock);

            await host.openEditorFile('/main.tex');
            await host.revealPreviewLocation(scroll.index, scroll.ratio, {
                anchors: ['sync anchor'],
                viewRatio: 0.25
            });

            assert.equal(host.getActivePath(), '/chapter.tex');
            assert.equal(editor.selectionAnchor, chapterText.indexOf('Included second paragraph'));
            assert.equal(editor.scrollDOM.scrollTop, editor.selectionAnchor + 175);
            assert.ok(editor.lastEffects);
        } finally {
            restoreWindow();
        }
    });
});
