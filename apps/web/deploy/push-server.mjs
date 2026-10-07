import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
            stdio: [options.input === undefined ? 'inherit' : 'pipe', options.capture ? 'pipe' : 'inherit', 'inherit']
        });
        const chunks = [];
        child.stdout?.on('data', chunk => chunks.push(chunk));
        child.once('error', reject);
        child.once('close', code => code === 0
            ? resolvePromise(Buffer.concat(chunks))
            : reject(new Error(`${command} exited with code ${code}`)));
        if (options.input !== undefined) {child.stdin.end(options.input);}
    });
}

const temp = await mkdtemp(join(tmpdir(), 'snaptex-deploy-'));
const archive = join(temp, 'source.tar.gz');
const fileList = join(temp, 'files.txt');
const remoteArchive = `/tmp/snaptex-${Date.now()}.tar.gz`;

try {
    // Upload build inputs, not repository documentation, recordings, or other hosts.
    const files = (await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
        'package.json', 'package-lock.json', 'esbuild.js', 'tsconfig.json', 'LICENSE',
        'src', 'apps/standalone', 'apps/web', 'demo', 'tools/icons/prepare-assets.mjs',
        'media/icon.svg', 'media/preview-style.css', ':(exclude)src/test'], { capture: true }))
        .toString('utf8').split('\0').filter(file => file && existsSync(join(repoRoot, file)));
    await writeFile(fileList, files.join('\n'));
    await run('tar', ['-czf', archive, '-T', fileList]);
    console.log(`[SnapTeX] Uploading ${files.length} source files (${((await stat(archive)).size / 1024 / 1024).toFixed(2)} MiB).`);
    await run('scp', [archive, `${host}:${remoteArchive}`]);

    const script = `set -Eeuo pipefail
root=${remoteRoot}
archive=${remoteArchive}
staging="\${root}.upload-$$"
previous="\${root}.previous"
cleanup() { rm -f "\$archive"; rm -rf "\$staging"; }
trap cleanup EXIT
mkdir -p "\$staging"
tar -xzf "\$archive" -C "\$staging"
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
