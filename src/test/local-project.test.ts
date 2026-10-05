/// <reference types="mocha" />

import * as assert from 'assert';
import { ProjectWriteConflictError } from '../../apps/standalone/src/browser-project';
import { createDirectoryProject, type BrowserDirectoryHandle, type BrowserFileHandle } from '../../apps/web/src/local-project';

class TestFileHandle implements BrowserFileHandle {
    kind = 'file' as const;
    name = 'main.tex';
    content = 'Original';
    modified = 1;
    onWrite?: () => void;

    async getFile(): Promise<File> {
        const content = this.content;
        return { size: content.length, lastModified: this.modified, text: async () => content } as File;
    }

    async createWritable() {
        return {
            write: async (text: string) => { this.content = text; },
            close: async () => { this.modified++; this.onWrite?.(); }
        };
    }
}

suite('Local browser project', () => {
    test('does not report its own save as an external file change', async () => {
        const globals = globalThis as unknown as Record<string, unknown>;
        const previousDocument = globals.document;
        const previousObserver = globals.FileSystemObserver;
        let notifyObserver: () => void = () => {};
        const file = new TestFileHandle();
        const pdf = new TestFileHandle();
        pdf.name = 'main.pdf';
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
            async *values() { yield file; yield pdf; }
        } as unknown as BrowserDirectoryHandle;
        const changes: string[] = [];
        let stop: (() => void) | undefined;

        try {
            const project = await createDirectoryProject(directory);
            const resources: string[] = [];
            stop = project.watchFiles!(change => { changes.push(change.text); }, error => { throw error; }, file => resources.push(file.path));
            await project.files[0].writeText?.('Saved locally');
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.deepEqual(changes, []);

            file.content = 'Changed outside SnapTeX';
            file.modified++;
            notifyObserver();
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.deepEqual(changes, ['Changed outside SnapTeX']);
            pdf.modified++;
            notifyObserver();
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.deepEqual(resources, [], 'Unopened resources must not be polled');
            await project.files.find(file => file.path === '/main.pdf')?.readBlob?.();
            pdf.modified++;
            notifyObserver();
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.deepEqual(resources, ['/main.pdf']);

            stop?.();
            stop = undefined;
            file.content = 'Change after project close';
            file.modified++;
            notifyObserver();
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.deepEqual(changes, ['Changed outside SnapTeX'], 'Closed projects must ignore later filesystem notifications');
        } finally {
            stop?.();
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
