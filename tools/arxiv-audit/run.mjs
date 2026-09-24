import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const repoRoot = resolve(import.meta.dirname, '../..');
const tempDir = join(repoRoot, '.tmp-arxiv-audit');
const bundlePath = join(tempDir, 'snaptex.cjs');
const corpusPath = join(repoRoot, 'tex_samplecode');

function run(script, args = []) {
    return new Promise((resolveRun, reject) => {
        const child = spawn(process.execPath, [script, ...args], {
            cwd: repoRoot,
            stdio: 'inherit',
            windowsHide: true
        });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolveRun() : reject(new Error(`${script} exited with code ${code}`)));
    });
}

await mkdir(tempDir, { recursive: true });
await build({
    entryPoints: [join(import.meta.dirname, 'entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'warning'
});
await run(join(import.meta.dirname, 'audit.cjs'), [bundlePath, corpusPath, ...process.argv.slice(2)]);
await run(join(import.meta.dirname, 'report.cjs'), [corpusPath]);
