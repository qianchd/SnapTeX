/// <reference types="mocha" />

import * as assert from 'assert';
import { mock } from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';
import { ProjectWriteConflictError } from '../../apps/standalone/src/browser-project';
import { createDirectoryProject, type BrowserDirectoryHandle, type BrowserFileHandle } from '../../apps/web/src/local-project';

class TestFileHandle implements BrowserFileHandle {
    kind = 'file' as const;
    name = 'main.tex';
    content = 'Original';
    modified = 1;
    onWrite?: () => void;
    failNextRead = false;
    readGate?: Promise<void>;

    async getFile(): Promise<File> {
        const content = this.content;
        const gate = this.readGate;
        this.readGate = undefined;
        return { size: content.length, lastModified: this.modified, text: async () => {
            if (this.failNextRead) { this.failNextRead = false; throw new Error('Temporary read failure'); }
            await gate;
            return content;
        } } as File;
    }

    async createWritable() {
        return {
            write: async (text: string) => { this.content = text; },
            close: async () => { this.modified++; this.onWrite?.(); }
        };
    }
}

suite('Local browser project', () => {
    test('observes external edits, recovers from failures, and ignores its own saves', async () => {
        const globals = globalThis as unknown as Record<string, unknown>;
        const previousDocument = globals.document;
        const previousObserver = globals.FileSystemObserver;
        let notifyObserver: () => void = () => {};
        const file = new TestFileHandle();
        const pdf = new TestFileHandle();
        pdf.name = 'main.pdf';
        const notes = new TestFileHandle();
        notes.name = 'notes.tex';
        file.onWrite = () => notifyObserver();
        globals.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
        globals.FileSystemObserver = class {
            constructor(callback: () => void) { notifyObserver = callback; }
            async observe() {}
            disconnect() {}
        };

        const directory = {
            kind: 'directory',
            name: 'project',
            async *values() { yield file; yield pdf; yield notes; }
        } as unknown as BrowserDirectoryHandle;
        const changes: string[] = [];
        const errors: unknown[] = [];
        let failUpdate = false;
        let finishRead: (() => void) | undefined;
        let stop: (() => void) | undefined;

        try {
            const project = await createDirectoryProject(directory);
            file.content = 'Edited before watching'; file.modified++;
            const resources: string[] = [];
            stop = project.watchFiles!(change => {
                if (failUpdate) { failUpdate = false; throw new Error('Temporary update failure'); }
                changes.push(change.text);
            }, error => errors.push(error), file => {resources.push(file.path);});
            await settle();
            assert.deepEqual(changes, ['Edited before watching'], 'Starting the observer must catch edits made during project loading');
            await project.files[0].writeText?.('Saved locally');
            await settle();
            assert.deepEqual(changes, ['Edited before watching']);

            file.content = 'Changed outside SnapTeX';
            file.modified++;
            pdf.modified++;
            notifyObserver();
            await settle();
            assert.deepEqual(changes, ['Edited before watching', 'Changed outside SnapTeX']);
            assert.deepEqual(resources, [], 'Unopened resources must not be polled');
            await project.files.find(file => file.path === '/main.pdf')?.readBlob?.();
            pdf.modified++;
            notifyObserver();
            await settle();
            assert.deepEqual(resources, ['/main.pdf']);

            const appliedChanges = changes.length;
            file.content = 'Snapshot before save'; file.modified++;
            file.readGate = new Promise(resolve => {finishRead = resolve;});
            notifyObserver();
            await settle();
            await project.files[0].writeText?.('Saved while reading');
            finishRead!();
            await settle();
            assert.equal(changes.length, appliedChanges, 'An older in-flight read must not undo a successful save');

            file.onWrite = () => {file.content = 'External during save'; file.modified++;};
            await project.files[0].writeText?.('Saved before external change');
            file.onWrite = () => notifyObserver();
            notifyObserver();
            await settle();
            assert.equal(changes.at(-1), 'External during save', 'Post-save metadata must not mark an external edit as already applied');

            mock.timers.enable({ apis: ['setTimeout'] });
            for (const stage of ['read', 'apply']) {
                file.content = `Recovered ${stage}`;
                file.modified++;
                file.failNextRead = stage === 'read';
                failUpdate = stage === 'apply';
                if (stage === 'read') { notes.content = 'Updated notes'; notes.modified++; }
                notifyObserver();
                await settle();
                assert.equal(changes.includes(file.content), false);
                if (stage === 'read') {
                    assert.equal(changes.at(-1), notes.content, 'One failed file must not block other changed files');
                }
                const failedText = file.content;
                file.content = `Newest ${stage}`;
                file.modified++;
                mock.timers.tick(5000);
                await settle();
                assert.equal(changes.at(-1), file.content, 'Retry must read the latest disk content even without another notification');
                assert.equal(changes.includes(failedText), false, 'Retry must not replay the failed snapshot');
            }
            assert.equal(errors.length, 2);

            const stoppedChanges = [...changes];
            stop?.();
            stop = undefined;
            file.content = 'Change after project close';
            file.modified++;
            notifyObserver();
            await settle();
            assert.deepEqual(changes, stoppedChanges, 'Closed projects must ignore later filesystem notifications');
        } finally {
            finishRead?.();
            stop?.();
            mock.timers.reset();
            if (previousDocument === undefined) {delete globals.document;}
            else {globals.document = previousDocument;}
            if (previousObserver === undefined) {delete globals.FileSystemObserver;}
            else {globals.FileSystemObserver = previousObserver;}
        }
    });

    test('rejects a local save when the file changed since its base was read', async () => {
        const file = new TestFileHandle();
        const directory = {
            kind: 'directory',
            name: 'project',
            async *values() { yield file; }
        } as unknown as BrowserDirectoryHandle;

        const project = await createDirectoryProject(directory);
        const main = project.files[0];
        assert.equal(await main.readText?.(), 'Original');
        file.content = 'External edit';
        file.modified++;

        await assert.rejects(
            async () => { await main.writeText?.('Local edit', 'Original'); },
            (error: unknown) => error instanceof ProjectWriteConflictError && error.remoteText === 'External edit'
        );
        assert.equal(file.content, 'External edit');
    });

    test('compares local save bases without treating line-ending differences as edits', async () => {
        const file = new TestFileHandle();
        file.content = 'First\r\nSecond';
        const directory = {
            kind: 'directory',
            name: 'project',
            async *values() { yield file; }
        } as unknown as BrowserDirectoryHandle;

        const project = await createDirectoryProject(directory);
        const main = project.files[0];
        const base = await main.readText?.();
        assert.equal(base, 'First\nSecond');
        await main.writeText?.('Updated', base);
        assert.equal(file.content, 'Updated');
    });
});
