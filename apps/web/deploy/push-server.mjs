import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const [host, remoteRoot] = process.argv.slice(2);

if (!host || !/^(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)
    || !remoteRoot || remoteRoot === '/' || remoteRoot.split('/').includes('..')
    || !/^\/[A-Za-z0-9._/-]+$/.test(remoteRoot)) {
    console.error('Usage: npm run web:deploy-server -- <ssh-host> </absolute/remote/source-path>');
    process.exit(2);
}

function run(command, args, options = {}) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, {
            cwd: repoRoot,
            stdio: [options.input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit']
        });
        child.once('error', reject);
        child.once('exit', code => code === 0
            ? resolvePromise()
            : reject(new Error(`${command} exited with code ${code}`)));
        if (options.input !== undefined) {child.stdin.end(options.input);}
    });
}

function capture(command, args) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
        const chunks = [];
        child.stdout.on('data', chunk => chunks.push(chunk));
        child.once('error', reject);
        child.once('exit', code => code === 0
            ? resolvePromise(Buffer.concat(chunks))
            : reject(new Error(`${command} exited with code ${code}`)));
    });
}

const temp = await mkdtemp(join(tmpdir(), 'snaptex-deploy-'));
const archive = join(temp, 'source.tar');
const fileList = join(temp, 'files.txt');
const remoteArchive = `/tmp/snaptex-${Date.now()}.tar`;

try {
    const files = (await capture('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
        .toString('utf8').split('\0').filter(Boolean);
    await writeFile(fileList, files.join('\n'));
    await run('tar', ['-cf', archive, '-T', fileList]);
    await run('scp', [archive, `${host}:${remoteArchive}`]);

    const script = `set -Eeuo pipefail
root=${remoteRoot}
archive=${remoteArchive}
staging="\${root}.upload-$$"
previous="\${root}.previous"
cleanup() { rm -f "\$archive"; rm -rf "\$staging"; }
trap cleanup EXIT
mkdir -p "\$staging"
tar -xf "\$archive" -C "\$staging"
if [[ -f "\$root/apps/web/server.env" ]]; then
    mkdir -p "\$staging/apps/web"
    cp -p "\$root/apps/web/server.env" "\$staging/apps/web/server.env"
fi
cd "\$staging"
npm run web:install-server
rm -rf "\$previous"
if [[ -d "\$root" ]]; then mv "\$root" "\$previous"; fi
if ! mv "\$staging" "\$root"; then
    if [[ -d "\$previous" ]]; then mv "\$previous" "\$root"; fi
    exit 1
fi
rm -rf "\$previous"
`;
    await run('ssh', [host, 'bash', '-s'], { input: script });
    console.log(`[SnapTeX] Deployed to ${host}:${remoteRoot}`);
} finally {
    await rm(temp, { recursive: true, force: true });
}
