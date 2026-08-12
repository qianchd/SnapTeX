import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSnapTeXWebServer } from './server.mjs';

test('serves a writable project through the remote project API', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'snaptex-web-'));
    const staticRoot = join(tempRoot, 'static');
    const projectRoot = join(tempRoot, 'project');
    await mkdir(join(projectRoot, 'sections'), { recursive: true });
    await mkdir(staticRoot);
    await writeFile(join(staticRoot, 'index.html'), 'SnapTeX');
    await writeFile(join(projectRoot, 'main.tex'), 'Original');
    await writeFile(join(projectRoot, 'sections', 'intro.tex'), 'Intro');
    await writeFile(join(projectRoot, 'figure.png'), 'image');
    await writeFile(join(projectRoot, 'build.aux'), 'ignored');

    const server = createSnapTeXWebServer({ root: staticRoot, projectRoot });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
        const manifest = await (await fetch(`${baseUrl}/api/project/manifest`)).json();
        assert.deepEqual(manifest, {
            rootPath: '/main.tex',
            files: ['/figure.png', '/main.tex', '/sections/intro.tex']
        });
        assert.equal(await (await fetch(`${baseUrl}/api/project/files/main.tex`)).text(), 'Original');
        const saved = await fetch(`${baseUrl}/api/project/files/main.tex`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: 'Updated'
        });
        assert.equal(saved.status, 204);
        assert.equal(await readFile(join(projectRoot, 'main.tex'), 'utf8'), 'Updated');
        assert.equal((await fetch(`${baseUrl}/api/project/files/build.aux`)).status, 404);
        assert.equal((await fetch(`${baseUrl}/api/project/files/%2e%2e%2Foutside.tex`)).status, 404);
    } finally {
        await new Promise(resolve => server.close(resolve));
        await rm(tempRoot, { recursive: true, force: true });
    }
});
