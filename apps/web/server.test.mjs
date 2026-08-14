import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSnapTeXWebServer } from './server.mjs';

test('serves a writable project through the remote project API', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'snaptex-web-'));
    const staticRoot = join(tempRoot, 'static');
    const outsideRoot = join(tempRoot, 'outside');
    const projectsRoot = join(tempRoot, 'projects');
    const projectRoot = join(projectsRoot, 'paper-one');
    await mkdir(join(projectRoot, 'sections'), { recursive: true });
    await mkdir(join(staticRoot, 'docs', 'guide'), { recursive: true });
    await mkdir(outsideRoot);
    await writeFile(join(staticRoot, 'index.html'), '<body data-deployment-mode="static">SnapTeX</body>');
    await writeFile(join(staticRoot, 'docs', 'index.html'), 'Documentation');
    await writeFile(join(staticRoot, 'docs', 'guide', 'start.html'), 'Getting started');
    await writeFile(join(outsideRoot, 'secret.txt'), 'Secret');
    await symlink(outsideRoot, join(staticRoot, 'linked'), 'junction');
    await writeFile(join(projectRoot, 'main.tex'), 'Original');
    await writeFile(join(projectRoot, 'sections', 'intro.tex'), 'Intro');
    await writeFile(join(projectRoot, 'figure.png'), 'image');
    await writeFile(join(projectRoot, 'build.aux'), 'ignored');

    assert.throws(
        () => createSnapTeXWebServer({ root: staticRoot, projectsRoot }),
        /require authentication/
    );
    const publicOrigin = 'https://snaptex.test';
    assert.throws(() => createSnapTeXWebServer({
        root: staticRoot,
        projectsRoot,
        auth: {
            username: 'test-user',
            password: 'a-secure-test-password',
            publicOrigin: `${publicOrigin}/nested`
        }
    }), /HTTPS origin without a path/);
    assert.throws(() => createSnapTeXWebServer({
        root: projectsRoot,
        projectsRoot,
        auth: {
            username: 'test-user',
            password: 'a-secure-test-password',
            publicOrigin
        }
    }), /separate directories/);
    assert.throws(() => createSnapTeXWebServer({
        root: staticRoot,
        projectsRoot,
        auth: {
            username: 'invalid\nuser',
            password: 'a-secure-test-password',
            publicOrigin
        }
    }), /username/);
    assert.throws(() => createSnapTeXWebServer({
        root: staticRoot,
        projectsRoot,
        auth: {
            username: 'test-user',
            password: 'too-short',
            publicOrigin
        }
    }), /16 characters/);
    const server = createSnapTeXWebServer({
        root: staticRoot,
        projectsRoot,
        auth: {
            username: 'test-user',
            password: 'a-secure-test-password',
            publicOrigin,
            publicPath: '/'
        }
    });
    assert.equal(server.requestTimeout, 30_000);
    assert.equal(server.headersTimeout, 15_000);
    assert.equal(server.maxHeadersCount, 100);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
        assert.match(await (await fetch(`${baseUrl}/`)).text(), /data-deployment-mode="server"/);
        assert.equal(await (await fetch(`${baseUrl}/docs/`)).text(), 'Documentation');
        assert.equal(await (await fetch(`${baseUrl}/docs/guide/start`)).text(), 'Getting started');
        const login = await fetch(`${baseUrl}/web-auth/login`, {
            method: 'POST',
            headers: { Origin: publicOrigin, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: 'test-user', password: 'a-secure-test-password' }),
            redirect: 'manual'
        });
        const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0];
        const { csrfToken } = await (await fetch(`${baseUrl}/web-auth/session`, { headers: { cookie } })).json();
        const authenticatedFetch = (url, init = {}) => {
            const headers = new Headers(init.headers);
            headers.set('Cookie', cookie);
            headers.set('Origin', publicOrigin);
            headers.set('X-CSRF-Token', csrfToken);
            return fetch(url, { ...init, headers });
        };

        assert.equal((await authenticatedFetch(`${baseUrl}/index.html`, { method: 'POST' })).status, 405);
        assert.equal((await fetch(`${baseUrl}/healthz`, { method: 'POST' })).status, 405);
        assert.equal((await authenticatedFetch(`${baseUrl}/linked/secret.txt`)).status, 404);
        assert.equal((await authenticatedFetch(`${baseUrl}/api/projects`)).status, 200);
        const manifest = await (await authenticatedFetch(`${baseUrl}/api/projects/paper-one/manifest`)).json();
        assert.deepEqual(manifest, {
            rootPath: '/main.tex',
            files: ['/figure.png', '/main.tex', '/sections/intro.tex']
        });
        assert.equal(await (await authenticatedFetch(`${baseUrl}/api/projects/paper-one/files/main.tex`)).text(), 'Original');
        const saved = await authenticatedFetch(`${baseUrl}/api/projects/paper-one/files/main.tex`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: 'Updated'
        });
        assert.equal(saved.status, 204);
        assert.equal(await readFile(join(projectRoot, 'main.tex'), 'utf8'), 'Updated');
        const createdFile = await authenticatedFetch(`${baseUrl}/api/projects/paper-one/files/notes.md`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: 'Notes'
        });
        assert.equal(createdFile.status, 201);
        assert.equal(await readFile(join(projectRoot, 'notes.md'), 'utf8'), 'Notes');
        assert.equal((await authenticatedFetch(`${baseUrl}/api/projects/paper-one/files/notes.md`, { method: 'DELETE' })).status, 204);
        await assert.rejects(() => access(join(projectRoot, 'notes.md')));
        const deleteRoot = await authenticatedFetch(`${baseUrl}/api/projects/paper-one/files/main.tex`, { method: 'DELETE' });
        assert.equal(deleteRoot.status, 204);
        await assert.rejects(() => access(join(projectRoot, 'main.tex')));
        const restoreRoot = await authenticatedFetch(`${baseUrl}/api/projects/paper-one/files/main.tex`, {
            method: 'POST',
            body: 'Restored'
        });
        assert.equal(restoreRoot.status, 201);
        const deleteOtherRoot = await authenticatedFetch(`${baseUrl}/api/projects/paper-one/files/sections/intro.tex`, { method: 'DELETE' });
        assert.equal(deleteOtherRoot.status, 204);
        const deleteLastRoot = await authenticatedFetch(`${baseUrl}/api/projects/paper-one/files/main.tex`, { method: 'DELETE' });
        assert.equal(deleteLastRoot.status, 409);
        await assert.doesNotReject(() => access(join(projectRoot, 'main.tex')));

        assert.equal((await authenticatedFetch(`${baseUrl}/api/projects/paper-one/files/build.aux`)).status, 404);
        assert.equal((await authenticatedFetch(`${baseUrl}/api/projects/paper-one/files/%2e%2e%2Foutside.tex`)).status, 404);
        assert.equal((await authenticatedFetch(`${baseUrl}/api/projects/paper-one/files/line%0Abreak.tex`, {
            method: 'POST', body: 'x'
        })).status, 404);
        assert.equal((await authenticatedFetch(`${baseUrl}/api/projects/paper-one/files/image.png`, { method: 'POST', body: 'x' })).status, 415);
        assert.equal((await authenticatedFetch(`${baseUrl}/api/projects/paper-one/files/main.tex`, { method: 'POST', body: 'x' })).status, 409);

        const missing = await authenticatedFetch(`${baseUrl}/api/projects/demo/manifest`);
        assert.equal(missing.status, 404);
        assert.equal((await missing.json()).code, 'PROJECT_NOT_FOUND');
        const createdProject = await authenticatedFetch(`${baseUrl}/api/projects/demo`, { method: 'POST' });
        assert.equal(createdProject.status, 201);
        assert.deepEqual(await createdProject.json(), { rootPath: '/main.tex', files: ['/main.tex'] });
        assert.match(await readFile(join(projectsRoot, 'demo', 'main.tex'), 'utf8'), /begin\{document\}/);
        assert.equal((await authenticatedFetch(`${baseUrl}/api/projects/demo`, { method: 'POST' })).status, 409);
        assert.equal((await authenticatedFetch(`${baseUrl}/api/projects/%252e%252e/manifest`)).status, 404);
        assert.equal((await authenticatedFetch(`${baseUrl}/api/projects/%252e%252e`, { method: 'POST' })).status, 404);
    } finally {
        await new Promise(resolve => server.close(resolve));
        await rm(tempRoot, { recursive: true, force: true });
    }
});

test('protects remote projects with an independent web session', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'snaptex-secure-web-'));
    const staticRoot = join(tempRoot, 'static');
    const projectsRoot = join(tempRoot, 'projects');
    const projectRoot = join(projectsRoot, 'paper');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(staticRoot);
    await mkdir(join(projectRoot, '.private'));
    await mkdir(join(projectsRoot, 'linked-target'));
    await writeFile(join(projectsRoot, 'linked-target', 'main.tex'), 'Linked');
    await symlink(join(projectsRoot, 'linked-target'), join(projectsRoot, 'linked-project'), 'junction');
    await writeFile(join(staticRoot, 'index.html'), 'SnapTeX');
    await writeFile(join(projectRoot, 'main.tex'), 'Original');
    await writeFile(join(projectRoot, '.private', 'hidden.tex'), 'Secret');
    await writeFile(join(projectRoot, 'active.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const publicOrigin = 'https://snaptex.example.com';
    const server = createSnapTeXWebServer({
        root: staticRoot,
        projectsRoot,
        auth: { username: 'owner', password: 'a-secure-test-password', publicOrigin, publicPath: '/' }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
        const anonymousPage = await fetch(`${baseUrl}/`, { redirect: 'manual' });
        assert.equal(anonymousPage.status, 200);
        assert.equal(await anonymousPage.text(), 'SnapTeX');
        assert.equal(anonymousPage.headers.get('cross-origin-opener-policy'), 'same-origin');
        assert.equal(anonymousPage.headers.get('cross-origin-resource-policy'), 'same-origin');
        assert.equal((await fetch(`${baseUrl}/api/projects`)).status, 401);
        assert.equal((await fetch(`${baseUrl}/web-auth/login`)).headers.get('referrer-policy'), 'same-origin');

        const crossOriginLogin = await fetch(`${baseUrl}/web-auth/login`, {
            method: 'POST',
            headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: 'owner', password: 'a-secure-test-password' }),
            redirect: 'manual'
        });
        assert.equal(crossOriginLogin.status, 403);
        assert.equal(crossOriginLogin.headers.get('set-cookie'), null);

        const login = await fetch(`${baseUrl}/web-auth/login`, {
            method: 'POST',
            headers: { Origin: publicOrigin, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: 'owner', password: 'a-secure-test-password', return_to: '//evil.example' }),
            redirect: 'manual'
        });
        assert.equal(login.status, 303);
        assert.equal(login.headers.get('location'), '/');
        const setCookie = login.headers.get('set-cookie') ?? '';
        assert.match(setCookie, /__Host-snaptex-session=/);
        assert.match(setCookie, /HttpOnly/);
        assert.match(setCookie, /Secure/);
        assert.match(setCookie, /SameSite=Strict/);
        const cookie = setCookie.split(';', 1)[0];
        const session = await fetch(`${baseUrl}/web-auth/session`, { headers: { cookie } });
        assert.equal(session.status, 200);
        const { csrfToken } = await session.json();
        assert.match(csrfToken, /^[A-Za-z0-9_-]{32,}$/);
        const sessionHeaders = { cookie, Origin: publicOrigin, 'X-CSRF-Token': csrfToken };

        const page = await fetch(`${baseUrl}/`, { headers: { cookie } });
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-security-policy'), /object-src 'none'/);
        assert.match(page.headers.get('content-security-policy'), /connect-src 'self' blob:/);
        assert.equal((await fetch(`${baseUrl}/api/projects/paper/files/.private/hidden.tex`, {
            headers: { cookie }
        })).status, 404);
        assert.equal((await fetch(`${baseUrl}/api/projects/linked-project/manifest`, {
            headers: { cookie }
        })).status, 404);
        const svg = await fetch(`${baseUrl}/api/projects/paper/files/active.svg`, { headers: { cookie } });
        assert.equal(svg.status, 200);
        assert.equal(svg.headers.get('content-security-policy'), "sandbox; default-src 'none'");

        const wrongOrigin = await fetch(`${baseUrl}/api/projects/paper/files/main.tex`, {
            method: 'PUT',
            headers: { cookie, Origin: 'https://evil.example', 'X-CSRF-Token': csrfToken, 'Content-Type': 'text/plain' },
            body: 'Rejected'
        });
        assert.equal(wrongOrigin.status, 403);
        assert.equal(await readFile(join(projectRoot, 'main.tex'), 'utf8'), 'Original');

        const missingCsrf = await fetch(`${baseUrl}/api/projects/paper/files/main.tex`, {
            method: 'PUT', headers: { cookie, Origin: publicOrigin }, body: 'Rejected'
        });
        assert.equal(missingCsrf.status, 403);

        const saved = await fetch(`${baseUrl}/api/projects/paper/files/main.tex`, {
            method: 'PUT',
            headers: { ...sessionHeaders, 'Content-Type': 'text/plain' },
            body: 'Accepted'
        });
        assert.equal(saved.status, 204);
        assert.equal(await readFile(join(projectRoot, 'main.tex'), 'utf8'), 'Accepted');

        assert.equal((await fetch(`${baseUrl}/web-auth/check`, {
            headers: { cookie, 'X-Original-Method': 'POST' }
        })).status, 403);
        const check = await fetch(`${baseUrl}/web-auth/check`, {
            headers: { cookie, 'X-Original-Method': 'POST', 'X-CSRF-Token': csrfToken }
        });
        assert.equal(check.status, 204);
        assert.equal(check.headers.get('x-authenticated-user'), 'owner');

        const logout = await fetch(`${baseUrl}/web-auth/logout`, {
            method: 'POST', headers: sessionHeaders
        });
        assert.equal(logout.status, 204);
        assert.equal((await fetch(`${baseUrl}/web-auth/session`, { headers: { cookie } })).status, 401);

        const blockedAddress = '203.0.113.10';
        let failure;
        for (let attempt = 0; attempt < 10; attempt += 1) {
            failure = await fetch(`${baseUrl}/web-auth/login`, {
                method: 'POST',
                headers: {
                    Origin: publicOrigin,
                    'X-Real-IP': blockedAddress,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({ username: 'owner', password: 'wrong-password' }),
                redirect: 'manual'
            });
        }
        assert.equal(failure.status, 429);
        assert.equal(failure.headers.get('retry-after'), String(30 * 24 * 60 * 60));

        const blockedLogin = await fetch(`${baseUrl}/web-auth/login`, {
            method: 'POST',
            headers: {
                Origin: publicOrigin,
                'X-Real-IP': blockedAddress,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({ username: 'owner', password: 'a-secure-test-password' }),
            redirect: 'manual'
        });
        assert.equal(blockedLogin.status, 429);

        const independentLogin = await fetch(`${baseUrl}/web-auth/login`, {
            method: 'POST',
            headers: {
                Origin: publicOrigin,
                'X-Real-IP': '203.0.113.11',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({ username: 'owner', password: 'a-secure-test-password' }),
            redirect: 'manual'
        });
        assert.equal(independentLogin.status, 303);

        for (let attempt = 0; attempt < 10; attempt += 1) {
            await fetch(`${baseUrl}/web-auth/login`, {
                method: 'POST',
                headers: {
                    Origin: publicOrigin,
                    'X-Real-IP': '203.0.113.12, 203.0.113.13',
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({ username: 'owner', password: 'wrong-password' }),
                redirect: 'manual'
            });
        }
        const rejectedSpoof = await fetch(`${baseUrl}/web-auth/login`, {
            method: 'POST',
            headers: {
                Origin: publicOrigin,
                'X-Real-IP': '203.0.113.14, 203.0.113.15',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({ username: 'owner', password: 'a-secure-test-password' }),
            redirect: 'manual'
        });
        assert.equal(rejectedSpoof.status, 429);
    } finally {
        await new Promise(resolve => server.close(resolve));
        await rm(tempRoot, { recursive: true, force: true });
    }
});

test('limits the source development server to public web assets', async () => {
    const server = createSnapTeXWebServer({ root: process.cwd() });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
        assert.equal((await fetch(`${baseUrl}/`)).status, 200);
        assert.equal((await fetch(`${baseUrl}/web-auth/session`)).status, 404);
        assert.equal((await fetch(`${baseUrl}/package.json`)).status, 404);
        assert.equal((await fetch(`${baseUrl}/apps/web/server.env`)).status, 404);
        assert.equal((await fetch(`${baseUrl}/media/%2e%2e%2fapps/web/server.env`)).status, 404);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
