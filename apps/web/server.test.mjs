import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSnapTeXWebServer } from './server.mjs';

test('serves a writable project through the remote project API', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'snaptex-web-'));
    const staticRoot = join(tempRoot, 'static');
    const projectsRoot = join(tempRoot, 'projects');
    const projectRoot = join(projectsRoot, 'paper-one');
    await mkdir(join(projectRoot, 'sections'), { recursive: true });
    await mkdir(staticRoot);
    await writeFile(join(staticRoot, 'index.html'), 'SnapTeX');
    await writeFile(join(projectRoot, 'main.tex'), 'Original');
    await writeFile(join(projectRoot, 'sections', 'intro.tex'), 'Intro');
    await writeFile(join(projectRoot, 'figure.png'), 'image');
    await writeFile(join(projectRoot, 'build.aux'), 'ignored');

    const server = createSnapTeXWebServer({ root: staticRoot, projectsRoot });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
        assert.equal((await fetch(`${baseUrl}/api/projects`)).status, 200);
        const manifest = await (await fetch(`${baseUrl}/api/projects/paper-one/manifest`)).json();
        assert.deepEqual(manifest, {
            rootPath: '/main.tex',
            files: ['/figure.png', '/main.tex', '/sections/intro.tex']
        });
        assert.equal(await (await fetch(`${baseUrl}/api/projects/paper-one/files/main.tex`)).text(), 'Original');
        const saved = await fetch(`${baseUrl}/api/projects/paper-one/files/main.tex`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: 'Updated'
        });
        assert.equal(saved.status, 204);
        assert.equal(await readFile(join(projectRoot, 'main.tex'), 'utf8'), 'Updated');
        const createdFile = await fetch(`${baseUrl}/api/projects/paper-one/files/notes.md`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: 'Notes'
        });
        assert.equal(createdFile.status, 201);
        assert.equal(await readFile(join(projectRoot, 'notes.md'), 'utf8'), 'Notes');
        assert.equal((await fetch(`${baseUrl}/api/projects/paper-one/files/notes.md`, { method: 'DELETE' })).status, 204);
        await assert.rejects(() => access(join(projectRoot, 'notes.md')));
        const deleteRoot = await fetch(`${baseUrl}/api/projects/paper-one/files/main.tex`, { method: 'DELETE' });
        assert.equal(deleteRoot.status, 204);
        await assert.rejects(() => access(join(projectRoot, 'main.tex')));
        const restoreRoot = await fetch(`${baseUrl}/api/projects/paper-one/files/main.tex`, {
            method: 'POST',
            body: 'Restored'
        });
        assert.equal(restoreRoot.status, 201);
        const deleteOtherRoot = await fetch(`${baseUrl}/api/projects/paper-one/files/sections/intro.tex`, { method: 'DELETE' });
        assert.equal(deleteOtherRoot.status, 204);
        const deleteLastRoot = await fetch(`${baseUrl}/api/projects/paper-one/files/main.tex`, { method: 'DELETE' });
        assert.equal(deleteLastRoot.status, 409);
        await assert.doesNotReject(() => access(join(projectRoot, 'main.tex')));

        assert.equal((await fetch(`${baseUrl}/api/projects/paper-one/files/build.aux`)).status, 404);
        assert.equal((await fetch(`${baseUrl}/api/projects/paper-one/files/%2e%2e%2Foutside.tex`)).status, 404);
        assert.equal((await fetch(`${baseUrl}/api/projects/paper-one/files/image.png`, { method: 'POST', body: 'x' })).status, 415);
        assert.equal((await fetch(`${baseUrl}/api/projects/paper-one/files/main.tex`, { method: 'POST', body: 'x' })).status, 409);

        const missing = await fetch(`${baseUrl}/api/projects/demo/manifest`);
        assert.equal(missing.status, 404);
        assert.equal((await missing.json()).code, 'PROJECT_NOT_FOUND');
        const createdProject = await fetch(`${baseUrl}/api/projects/demo`, { method: 'POST' });
        assert.equal(createdProject.status, 201);
        assert.deepEqual(await createdProject.json(), { rootPath: '/main.tex', files: ['/main.tex'] });
        assert.match(await readFile(join(projectsRoot, 'demo', 'main.tex'), 'utf8'), /begin\{document\}/);
        assert.equal((await fetch(`${baseUrl}/api/projects/demo`, { method: 'POST' })).status, 409);
        assert.equal((await fetch(`${baseUrl}/api/projects/%2e%2e/manifest`)).status, 404);
        assert.equal((await fetch(`${baseUrl}/api/projects/%2e%2e`, { method: 'POST' })).status, 404);
    } finally {
        await new Promise(resolve => server.close(resolve));
        await rm(tempRoot, { recursive: true, force: true });
    }
});
