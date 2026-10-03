/// <reference types="mocha" />

import * as assert from 'assert';
import { EditorState, type StateEffect, type Transaction, type TransactionSpec } from '@codemirror/state';
import { history, undo, undoDepth } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { StandaloneHost } from '../../apps/standalone/src/app';
import { ProjectWriteConflictError, type BrowserProjectTextChange } from '../../apps/standalone/src/browser-project';
import { HostToPreviewCommand, PreviewToHostCommand, type HostToPreviewMessage } from '../preview-messages';

class TestEditorView {
    public state: EditorState;
    public lastEffects: readonly StateEffect<unknown>[] = [];
    public lastChange: { from: number; to: number; insert: string } | undefined;
    public scrollDOM = { scrollTop: 0, clientHeight: 100 };

    constructor(text = '') {
        this.state = EditorState.create({ doc: text, extensions: history() });
    }
    get selectionAnchor() { return this.state.selection.main.anchor; }
    set selectionAnchor(anchor: number) { this.dispatch({ selection: { anchor } }); }

    dispatch(update: TransactionSpec | Transaction) {
        const transaction = 'startState' in update ? update : this.state.update(update);
        transaction.changes.iterChanges((from, to, _newFrom, _newTo, insert) => {
            this.lastChange = { from, to, insert: insert.toString() };
        });
        this.lastEffects = transaction.effects;
        this.state = transaction.state;
    }

    replaceText(text: string) {
        this.dispatch({ changes: { from: 0, to: this.state.doc.length, insert: text } });
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
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
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
    test('saving and receiving a self-write preserve the editor selection and undo history', async () => {
        const editor = new TestEditorView();
        const restoreWindow = installWindow([]);
        const host = new StandaloneHost(editor as unknown as EditorView, '/main.tex', undefined, undefined, { autoSave: false });
        let diskText = 'First\nMiddle\nLast';
        let receiveChange: ((change: BrowserProjectTextChange) => Promise<void> | void) | undefined;
        try {
            await host.loadProject({ files: [{
                path: '/main.tex', text: diskText,
                readText: async () => diskText,
                writeText: text => { diskText = text; }
            }], watchTextFiles: callback => { receiveChange = callback; return () => undefined; } });
            const anchor = editor.state.doc.line(2).to;
            editor.dispatch({ changes: { from: anchor, insert: ' edited' }, selection: { anchor: anchor + 7 } });
            host.handleEditorUpdate();
            const state = editor.state;
            const depth = undoDepth(state);
            assert.ok(depth > 0);
            await host.saveCurrentText();
            assert.ok(receiveChange);
            await receiveChange({ path: '/main.tex', text: diskText });
            assert.equal(editor.state, state, 'A save must not dispatch an editor replacement');
            assert.equal(undoDepth(editor.state), depth);
            assert.equal(undo({ state: editor.state, dispatch: transaction => editor.dispatch(transaction) }), true);
            assert.equal(editor.state.doc.toString(), 'First\nMiddle\nLast');
        } finally {
            restoreWindow();
        }
    });

    test('maps the cursor and undo history across an external insertion', async () => {
        const editor = new TestEditorView();
        const restoreWindow = installWindow([]);
        const host = new StandaloneHost(editor as unknown as EditorView, '/main.tex', undefined, undefined, { autoSave: false });
        let receiveChange: ((change: BrowserProjectTextChange) => Promise<void> | void) | undefined;
        try {
            await host.loadProject({
                files: [{ path: '/main.tex', text: 'First\nMiddle\nLast' }],
                watchTextFiles: callback => { receiveChange = callback; return () => undefined; }
            });
            const anchor = editor.state.doc.line(2).to;
            editor.dispatch({ changes: { from: anchor, insert: ' edited' }, selection: { anchor: anchor + 7 } });
            host.handleEditorUpdate();
            editor.scrollDOM.scrollTop = 75;
            const depth = undoDepth(editor.state);

            await receiveChange?.({ path: '/main.tex', text: 'External heading\nFirst\nMiddle\nLast' });

            assert.equal(editor.state.doc.toString(), 'External heading\nFirst\nMiddle edited\nLast');
            assert.equal(editor.selectionAnchor, anchor + 7 + 'External heading\n'.length);
            assert.equal(editor.scrollDOM.scrollTop, 75);
            assert.equal(undoDepth(editor.state), depth, 'External updates must not become user undo steps');
            assert.equal(undo({ state: editor.state, dispatch: transaction => editor.dispatch(transaction) }), true);
            assert.equal(editor.state.doc.toString(), 'External heading\nFirst\nMiddle\nLast');
        } finally {
            restoreWindow();
        }
    });

    test('merges remote edits against the saved text and reports overlapping changes', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        let receiveChange: ((change: BrowserProjectTextChange) => Promise<void> | void) | undefined;
        const writes: string[] = [];
        const host = new StandaloneHost(editor as unknown as EditorView);

        try {
            await host.loadProject({
                files: [{ path: '/main.tex', text: 'First\nMiddle\nLast', writeText: text => { writes.push(text); } }],
                rootPath: '/main.tex',
                watchTextFiles: onChange => {
                    receiveChange = onChange;
                    return () => undefined;
                }
            });
            editor.replaceText('Local first\nMiddle\nLast');
            editor.selectionAnchor = 'Local first\n'.length + 2;
            host.handleEditorUpdate();

            await receiveChange?.({ path: '/main.tex', text: 'First\nMiddle\nRemote last' });
            assert.equal(editor.state.doc.toString(), 'Local first\nMiddle\nRemote last');
            assert.equal(editor.selectionAnchor, 'Local first\n'.length + 2);
            assert.ok(editor.lastChange && editor.lastChange.from > 0);
            assert.equal(host.isDirty('/main.tex'), true);
            assert.deepEqual(host.getDiagnostics(), []);

            await receiveChange?.({ path: '/main.tex', text: 'Remote first\nMiddle\nRemote last' });
            assert.match(editor.state.doc.toString(), /<<<<<<< LOCAL[\s\S]*Remote first[\s\S]*>>>>>>> REMOTE/);
            assert.match(host.getDiagnostics().join('\n'), /conflict markers/i);
            await assert.rejects(() => host.saveCurrentText(), /Resolve the remote edit conflict markers/);
            assert.deepEqual(writes, []);
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
                writeText: async (text, expectedText) => {
                    if (firstWrite) {
                        firstWrite = false;
                        assert.equal(expectedText, 'First\nMiddle\nLast');
                        throw new ProjectWriteConflictError('/main.tex', 'First\nMiddle\nRemote last');
                    }
                    assert.equal(expectedText, 'First\nMiddle\nRemote last');
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

    test('serializes saves without clearing edits made while a write is pending', async () => {
        const editor = new TestEditorView();
        const restoreWindow = installWindow([]);
        const host = new StandaloneHost(editor as unknown as EditorView, '/main.tex', undefined, undefined, { autoSave: false });
        const writes: string[] = [];
        let releaseWrite: () => void = () => undefined;
        const pendingWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
        let concurrentWrites = 0;
        let peakWrites = 0;
        let diskText = 'Base';
        let receiveChange: ((change: BrowserProjectTextChange) => Promise<void> | void) | undefined;

        try {
            await host.loadProject({ files: [{
                path: '/main.tex', text: 'Base',
                readText: async () => diskText,
                writeText: async text => {
                    peakWrites = Math.max(peakWrites, ++concurrentWrites);
                    writes.push(text);
                    if (writes.length === 1) {await pendingWrite;}
                    await flushAsync();
                    diskText = text;
                    concurrentWrites--;
                }
            }], watchTextFiles: onChange => {
                receiveChange = onChange;
                return () => undefined;
            } });
            editor.replaceText('First edit');
            host.handleEditorUpdate();
            const firstSave = host.saveCurrentText();
            await flushAsync();
            editor.replaceText('Second edit');
            host.handleEditorUpdate();
            const queuedChange = receiveChange?.({ path: '/main.tex', text: 'Base' });
            releaseWrite();
            await firstSave;
            await queuedChange;
            assert.equal(host.isDirty('/main.tex'), true);
            assert.equal(editor.state.doc.toString(), 'Second edit');
            const saves = [host.saveCurrentText(), host.saveCurrentText()];
            await Promise.all(saves);
            assert.deepEqual(writes, ['First edit', 'Second edit', 'Second edit']);
            assert.equal(peakWrites, 1);
            assert.equal(host.isDirty('/main.tex'), false);
            assert.equal(editor.state.doc.toString(), 'Second edit');
        } finally {
            releaseWrite();
            restoreWindow();
        }
    });

    test('keeps failed saves dirty and allows the project write queue to recover', async () => {
        const editor = new TestEditorView();
        const restoreWindow = installWindow([]);
        const writes: string[] = [];
        let failNextWrite = true;
        const host = new StandaloneHost(editor as unknown as EditorView, '/main.tex', undefined, undefined, { autoSave: false });
        try {
            await host.loadProject({
                files: [{
                    path: '/main.tex',
                    text: 'Base',
                    writeText: async text => {
                        writes.push(text);
                        if (failNextWrite) {
                            failNextWrite = false;
                            throw new Error('Disk is temporarily unavailable.');
                        }
                    }
                }]
            });
            editor.replaceText('Edited');
            host.handleEditorUpdate();

            await assert.rejects(host.saveCurrentText(), /temporarily unavailable/);
            assert.equal(host.isDirty('/main.tex'), true);
            assert.equal(editor.state.doc.toString(), 'Edited');

            await host.saveCurrentText();
            assert.deepEqual(writes, ['Edited', 'Edited']);
            assert.equal(host.isDirty('/main.tex'), false);
        } finally {
            restoreWindow();
        }
    });

    test('autosaves only dirty writable files and cancels disabled saves', async () => {
        const editor = new TestEditorView();
        const restoreWindow = installWindow([]);
        const writes: Array<{ text: string; expectedText?: string }> = [];
        let resolveSaved: () => void = () => undefined;
        const saved = new Promise<void>(resolve => { resolveSaved = resolve; });
        let timer: (() => void) | undefined;
        let scheduled = 0;
        window.setTimeout = ((callback: () => void, delay: number) => {
            assert.equal(delay, 2000, 'Autosave must honor the configured interval');
            timer = callback;
            return ++scheduled;
        }) as typeof window.setTimeout;
        window.clearTimeout = () => { timer = undefined; };
        const host = new StandaloneHost(editor as unknown as EditorView, '/main.tex', undefined, undefined, {
            autoSave: false, autoSaveIntervalSeconds: 2
        });
        try {
            await host.loadProject({ files: [
                { path: '/main.tex', text: 'Base', writeText: (text, expectedText) => { writes.push({ text, expectedText }); resolveSaved(); } },
                { path: '/readonly.tex', text: 'Read only' }
            ] });
            editor.replaceText('Edited');
            host.handleEditorUpdate();
            assert.equal(timer, undefined, 'Disabled autosave must not schedule writes');

            await host.updateSettings({ autoSave: true });
            assert.ok(timer);
            const fire = timer;
            timer = undefined;
            fire();
            await saved;
            await flushAsync();
            assert.deepEqual(writes, [{ text: 'Edited', expectedText: 'Base' }]);
            assert.equal(host.isDirty('/main.tex'), false);
            host.handleEditorUpdate();
            assert.equal(timer, undefined, 'Clean files must not schedule another save');
            assert.equal(scheduled, 1);

            editor.replaceText('Second edit');
            host.handleEditorUpdate();
            assert.ok(timer);
            await host.updateSettings({ autoSave: false });
            assert.equal(timer, undefined, 'Disabling autosave must cancel a pending write');
            await host.flushProjectWrites();
            assert.equal(writes.length, 1);
            assert.equal(host.isDirty('/main.tex'), true);

            await host.openEditorFile('/readonly.tex');
            await host.updateSettings({ autoSave: true });
            editor.replaceText('Read-only edit');
            host.handleEditorUpdate();
            assert.equal(timer, undefined, 'A read-only project file must not schedule writes');
            await host.flushProjectWrites();
            assert.equal(writes.length, 1);
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
            assert.equal(host.isDirty('/main.tex'), false);

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            await assert.rejects(() => host.openEditorFile('/unreadable.tex'), /Permission denied/);
            assert.equal(host.getActivePath(), '/main.tex');
            await host.openEditorFile('/chapter.tex');
            host.handleEditorUpdate();
            assert.equal(host.isDirty('/chapter.tex'), false);
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
            await assert.rejects(() => host.setPreviewRoot('/missing.tex'), /does not exist/);
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

    test('resolves relative image and PDF paths inside the opened project', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        const host = new StandaloneHost(editor as unknown as EditorView);

        try {
            await host.loadProject({
                rootPath: '/subfold/root.tex',
                files: [
                    {
                        path: '/subfold/root.tex',
                        text: [
                            '\\begin{figure}',
                            '\\includegraphics{../figures/a.png}',
                            '\\includegraphics{../../outside.png}',
                            '\\end{figure}'
                        ].join('\n')
                    },
                    { path: '/figures/a.png', resourceUrl: 'https://assets.test/a.png' },
                    { path: '/figures/a.pdf', resourceUrl: 'https://assets.test/a.pdf' },
                    { path: '/outside.png', resourceUrl: 'https://assets.test/outside.png' }
                ]
            });

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            const html = await requestBlockHtml(host, messages);
            assert.match(html, /src="https:\/\/assets\.test\/a\.png"/);
            assert.doesNotMatch(html, /assets\.test\/outside\.png/);

            await host.handlePreviewMessage({ command: PreviewToHostCommand.RequestPdf, id: 'pdf-relative', path: '../figures/a.pdf' });
            const pdf = messages.find(message => message.command === HostToPreviewCommand.PdfUri && message.id === 'pdf-relative');
            assert.ok(pdf && pdf.command === HostToPreviewCommand.PdfUri);
            assert.equal(pdf.uri, 'https://assets.test/a.pdf');

            await host.handlePreviewMessage({ command: PreviewToHostCommand.RequestPdf, id: 'pdf-outside', path: '../../outside.pdf' });
            const outsidePdf = messages.find(message => message.command === HostToPreviewCommand.PdfUri && message.id === 'pdf-outside');
            assert.ok(outsidePdf && outsidePdf.command === HostToPreviewCommand.PdfUri);
            assert.match(outsidePdf.error ?? '', /outside the project root/);
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

            host.setPaneVisibility(true, false);
            const messageCount = messages.length;
            host.syncEditorSelection(1, 0, 'Included first paragraph.');
            host.syncEditorSelection(2, 28, 'Included second paragraph with \\textbf{sync anchor}.');
            assert.equal(messages.length, messageCount);
            host.setPaneVisibility(true, true);
            assert.equal(messages.length, messageCount + 1);
            const resumedSync = messages.at(-1);
            assert.ok(resumedSync && resumedSync.command === HostToPreviewCommand.ScrollToBlock);
            assert.match(resumedSync.anchor ?? '', /sync anchor/, 'Only the latest hidden-panel target should be applied');
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
            fontFamily: 'Arial, sans-serif',
            pageMargin: '10% 8%',
            continuousMargin: '2em'
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
                fontFamily: 'Arial, sans-serif',
                pageMargin: '10% 8%',
                continuousMargin: '2em'
            });

            editor.replaceText('Changed paragraph.');
            host.handleEditorUpdate();
            assert.equal(scheduledRenders, 0);

            host.syncEditorSelection(1, 0, 'Changed paragraph.');
            assert.equal(messages.some(message => message.command === HostToPreviewCommand.ScrollToBlock), false);

            await host.updateSettings({ livePreview: true, autoScrollSync: true });
            host.handleEditorUpdate();
            assert.equal(scheduledRenders, 1);

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLayoutChanged });
            const messageCount = messages.length;
            host.syncEditorSelection(0, 0, 'Changed paragraph.');
            assert.equal(messages.length, messageCount);
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

            await host.updateSettings({ backendMode: 'ast(experimental)' });
            const updates = messages.filter(message => message.command === HostToPreviewCommand.Update);
            const lastUpdate = updates[updates.length - 1];

            assert.equal(updates.length, updateCount + 1);
            assert.ok(lastUpdate && lastUpdate.command === HostToPreviewCommand.Update);
            assert.ok(lastUpdate.payload.type === 'full');
            assert.equal(lastUpdate.payload.resetPreviewState, true);

            await host.updateSettings({ backendMode: 'legacy' });
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
            ], rootPath: '/main.tex' });

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            await host.openEditorFile('/chapter.tex');
            host.syncEditorSelection(2, 28, 'Included second paragraph with \\textbf{sync anchor}.');
            const scroll = [...messages].reverse().find(message => message.command === HostToPreviewCommand.ScrollToBlock);
            assert.ok(scroll && scroll.command === HostToPreviewCommand.ScrollToBlock);

            await host.openEditorFile('/main.tex');
            const updateCount = messages.filter(message => message.command === HostToPreviewCommand.Update).length;
            host.setPaneVisibility(false, true);
            await host.syncPreviewScroll(scroll.index, scroll.ratio);

            assert.equal(host.getActivePath(), '/chapter.tex');
            assert.equal(messages.filter(message => message.command === HostToPreviewCommand.Update).length, updateCount);
            assert.equal(editor.scrollDOM.scrollTop, 0);
            host.setPaneVisibility(true, true);
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

    test('keeps preview-driven scrolling from rebounding through the editor', async () => {
        const editor = new TestEditorView();
        const messages: HostToPreviewMessage[] = [];
        const restoreWindow = installWindow(messages);
        let cancelledSyncs = 0;
        const host = new StandaloneHost(editor as unknown as EditorView, '/main.tex', undefined, undefined, {},
            () => { cancelledSyncs += 1; });

        try {
            await host.loadProject({
                files: [{ path: '/main.tex', text: '\\begin{document}\nFirst paragraph.\nSecond paragraph.\n\\end{document}' }],
                rootPath: '/main.tex'
            });
            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewLoaded });
            host.syncEditorSelection(1, 0, 'First paragraph.');
            const scrollCount = () => messages.filter(message => message.command === HostToPreviewCommand.ScrollToBlock).length;
            assert.equal(scrollCount(), 1);

            await host.handlePreviewMessage({ command: PreviewToHostCommand.PreviewScrollStarted });
            host.syncEditorSelection(2, 0, 'Second paragraph.');
            assert.equal(scrollCount(), 1);
            assert.equal(cancelledSyncs, 1);

            host.beginEditorInteraction();
            host.syncEditorSelection(2, 0, 'Second paragraph.');
            assert.equal(scrollCount(), 2);

            host.setPaneVisibility(false, true);
            host.syncEditorSelection(0, 0, '\\begin{document}');
            assert.equal(scrollCount(), 2);
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
            assert.ok(editor.lastEffects.length > 0, 'A preview jump should emit an editor highlight effect');
        } finally {
            restoreWindow();
        }
    });
});
