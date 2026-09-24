import { createGunzip } from 'node:zlib';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '../..');
const outputRoot = join(repoRoot, 'tex_samplecode');
const manifestPath = join(outputRoot, 'manifest.json');
const categories = [
    'stat.ME', 'stat.CO', 'stat.ML', 'stat.AP', 'stat.OT',
    'math.PR', 'math.OC', 'math.NA', 'math.ST', 'math.CO'
];
const targetPerCategory = 10;
const candidatesPerCategory = 100;
const requestIntervalMs = 3100;
const maxArchiveBytes = 100 * 1024 * 1024;
const packageVersion = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version;
const headers = {
    'User-Agent': `SnapTeX-compatibility-audit/${packageVersion} (local research; https://github.com/qianchd/SnapTeX)`
};
let lastRequestAt = 0;

const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

async function politeFetch(url, attempts = 4) {
    const delay = requestIntervalMs - (Date.now() - lastRequestAt);
    if (delay > 0) {await wait(delay);}
    for (let attempt = 0; attempt < attempts; attempt++) {
        lastRequestAt = Date.now();
        try {
            const response = await fetch(url, {
                headers,
                redirect: 'follow',
                signal: AbortSignal.timeout(60_000)
            });
            if (response.ok) {return response;}
            if (![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts - 1) {
                throw new Error(`${response.status} ${response.statusText}: ${url}`);
            }
        } catch (error) {
            if (attempt === attempts - 1) {throw error;}
        }
        await wait(requestIntervalMs * (attempt + 2));
    }
    throw new Error(`Unable to fetch ${url}`);
}

async function politeDownload(url, outputPath, attempts = 3) {
    const delay = requestIntervalMs - (Date.now() - lastRequestAt);
    if (delay > 0) {await wait(delay);}
    let failure = '';
    for (let attempt = 0; attempt < attempts; attempt++) {
        lastRequestAt = Date.now();
        const result = await run(process.platform === 'win32' ? 'curl.exe' : 'curl', [
            '--fail', '--location', '--silent', '--show-error', '--max-time', '60',
            ...(attempt === 0 ? [] : ['--continue-at', '-']),
            '--user-agent', headers['User-Agent'], '--output', outputPath, url
        ], repoRoot);
        if (result.code === 0) {return;}
        failure = result.stderr.trim() || `curl exited with code ${result.code}`;
        if (attempt < attempts - 1) {await wait(requestIntervalMs * (attempt + 2));}
    }
    throw new Error(failure);
}

function decodeXml(value) {
    return value
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseEntries(xml, category) {
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => {
        const id = entry.match(/<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/)?.[1]?.replace(/v\d+$/, '');
        const title = decodeXml(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').replace(/\s+/g, ' ').trim();
        const published = entry.match(/<published>([^<]+)<\/published>/)?.[1];
        const primaryCategory = entry.match(/<arxiv:primary_category[^>]+term="([^"]+)"/)?.[1];
        const allCategories = [...entry.matchAll(/<category[^>]+term="([^"]+)"/g)].map(match => match[1]);
        return { id, title, published, primaryCategory, categories: allCategories, sampledFrom: category };
    }).filter(entry => entry.id);
}

function run(command, args, cwd) {
    return new Promise(resolveRun => {
        const child = spawn(command, args, { cwd, windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', code => resolveRun({ code, stdout, stderr }));
    });
}

async function listFiles(root, current = root) {
    const files = [];
    for (const entry of await readdir(current, { withFileTypes: true })) {
        if (entry.name === '__MACOSX' || entry.name === '.DS_Store') {continue;}
        const path = join(current, entry.name);
        if (entry.isDirectory()) {files.push(...await listFiles(root, path));}
        else if (entry.isFile()) {files.push(relative(root, path).replaceAll('\\', '/'));}
    }
    return files;
}

function archiveEntryIsSafe(name) {
    const normalized = name.replaceAll('\\', '/');
    return normalized && !normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized)
        && !normalized.split('/').includes('..');
}

async function unpackSource(archivePath, paperDir) {
    const listing = await run('tar', ['-tf', archivePath], paperDir);
    if (listing.code === 0) {
        const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
        if (entries.length === 0 || entries.some(entry => !archiveEntryIsSafe(entry))) {
            throw new Error('Unsafe or empty source archive');
        }
        const verbose = await run('tar', ['-tvf', archivePath], paperDir);
        if (verbose.code === 0 && verbose.stdout.split(/\r?\n/).some(line => /^[lh]/i.test(line))) {
            throw new Error('Source archive contains links');
        }
        const extracted = await run('tar', ['-xf', archivePath], paperDir);
        if (extracted.code !== 0) {throw new Error(extracted.stderr.trim() || 'tar extraction failed');}
        return;
    }

    const bytes = await readFile(archivePath);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const plainPath = join(paperDir, '_source.unpacked');
        await pipeline(createReadStream(archivePath), createGunzip(), createWriteStream(plainPath));
        const nested = await run('tar', ['-tf', plainPath], paperDir);
        if (nested.code === 0) {
            const entries = nested.stdout.split(/\r?\n/).filter(Boolean);
            if (entries.some(entry => !archiveEntryIsSafe(entry))) {throw new Error('Unsafe nested source archive');}
            const extracted = await run('tar', ['-xf', plainPath], paperDir);
            if (extracted.code !== 0) {throw new Error(extracted.stderr.trim() || 'nested tar extraction failed');}
            await rm(plainPath, { force: true });
            return;
        }
        const text = await readFile(plainPath, 'utf8');
        if (/\\(?:documentclass|begin\s*\{document\})/.test(text)) {
            await writeFile(join(paperDir, 'main.tex'), text);
            await rm(plainPath, { force: true });
            return;
        }
    }
    const text = bytes.toString('utf8');
    if (/\\(?:documentclass|begin\s*\{document\})/.test(text)) {
        await writeFile(join(paperDir, 'main.tex'), text);
        return;
    }
    throw new Error('Downloaded source is not a TeX source archive');
}

async function chooseRoot(paperDir, files) {
    const texFiles = files.filter(file => /\.(?:tex|ltx|latex)$/i.test(file));
    const ranked = [];
    for (const file of texFiles) {
        let text;
        try { text = await readFile(join(paperDir, file), 'utf8'); } catch { continue; }
        const name = basename(file, extname(file)).toLowerCase();
        let score = Math.min(text.length, 1_000_000) / 1000;
        if (/\\documentclass(?:\s*\[[^\]]*\])?\s*\{/.test(text)) {score += 10_000;}
        if (/\\begin\s*\{document\}/.test(text)) {score += 20_000;}
        if (/^(?:main|paper|manuscript|article|ms|root|submission)$/.test(name)) {score += 2_000;}
        if (/(?:preamble|commands|macros|header|config)/.test(name)) {score -= 5_000;}
        if (/(?:supp|appendix|response|cover|letter)/.test(name)) {score -= 1_000;}
        ranked.push({ file, score, bytes: Buffer.byteLength(text) });
    }
    ranked.sort((left, right) => right.score - left.score || right.bytes - left.bytes);
    return { root: ranked[0]?.file, texFiles, candidates: ranked.slice(0, 5) };
}

async function downloadPaper(entry) {
    const paperDir = join(outputRoot, entry.id.replace('/', '_'));
    const metadataPath = join(paperDir, '_sample.json');
    if (existsSync(metadataPath)) {
        const saved = JSON.parse(await readFile(metadataPath, 'utf8'));
        if (saved.root && existsSync(join(paperDir, saved.root))) {return saved;}
    }
    await rm(paperDir, { recursive: true, force: true });
    await mkdir(paperDir, { recursive: true });
    const archivePath = join(paperDir, '_source.download');
    try {
        const sourceUrl = `https://arxiv.org/e-print/${entry.id}`;
        await politeDownload(sourceUrl, archivePath);
        if ((await stat(archivePath)).size > maxArchiveBytes) {throw new Error('Source archive exceeds 100 MB');}
        await unpackSource(archivePath, paperDir);
        await rm(archivePath, { force: true });
        const files = await listFiles(paperDir);
        const rootInfo = await chooseRoot(paperDir, files);
        if (!rootInfo.root) {throw new Error('No root TeX document found');}
        const metadata = {
            ...entry,
            sourceUrl,
            folder: basename(paperDir),
            root: rootInfo.root,
            texFileCount: rootInfo.texFiles.length,
            rootCandidates: rootInfo.candidates,
            fileCount: files.length
        };
        await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
        return metadata;
    } catch (error) {
        await rm(paperDir, { recursive: true, force: true });
        throw error;
    }
}

async function loadManifest() {
    if (!existsSync(manifestPath)) {return { generatedAt: undefined, samples: [], failures: [] };}
    return JSON.parse(await readFile(manifestPath, 'utf8'));
}

async function saveManifest(manifest) {
    manifest.generatedAt = new Date().toISOString();
    manifest.sampleCount = manifest.samples.length;
    manifest.categories = Object.fromEntries(categories.map(category => [
        category,
        manifest.samples.filter(sample => sample.sampledFrom === category).length
    ]));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function refreshRoot(sample) {
    const paperDir = join(outputRoot, sample.folder);
    const files = await listFiles(paperDir);
    const rootInfo = await chooseRoot(paperDir, files);
    if (!rootInfo.root) {throw new Error(`No root TeX document found for ${sample.id}`);}
    Object.assign(sample, {
        root: rootInfo.root,
        texFileCount: rootInfo.texFiles.length,
        rootCandidates: rootInfo.candidates,
        fileCount: files.length
    });
    await writeFile(join(paperDir, '_sample.json'), `${JSON.stringify(sample, null, 2)}\n`);
}

await mkdir(outputRoot, { recursive: true });
const manifest = await loadManifest();
if (process.argv.includes('--refresh-roots')) {
    for (const sample of manifest.samples) {
        const previousRoot = sample.root;
        await refreshRoot(sample);
        if (sample.root !== previousRoot) {console.log(`[root] ${sample.id}: ${previousRoot} -> ${sample.root}`);}
    }
    await saveManifest(manifest);
}
const attemptedIds = new Set(manifest.samples.map(sample => sample.id));

for (const category of categories) {
    let selected = manifest.samples.filter(sample => sample.sampledFrom === category).length;
    if (selected >= targetPerCategory) {continue;}
    const query = new URL('https://export.arxiv.org/api/query');
    query.searchParams.set('search_query', `cat:${category}`);
    query.searchParams.set('start', '0');
    query.searchParams.set('max_results', String(candidatesPerCategory));
    query.searchParams.set('sortBy', 'submittedDate');
    query.searchParams.set('sortOrder', 'descending');
    console.log(`[metadata] ${category}`);
    const entries = parseEntries(await (await politeFetch(query)).text(), category);
    for (const entry of entries) {
        if (selected >= targetPerCategory) {break;}
        if (attemptedIds.has(entry.id)) {continue;}
        try {
            console.log(`[source ${manifest.samples.length + 1}/100] ${entry.id} ${category}`);
            const sample = await downloadPaper(entry);
            manifest.samples.push(sample);
            manifest.failures = manifest.failures.filter(failure => failure.id !== entry.id);
            attemptedIds.add(entry.id);
            selected += 1;
            await saveManifest(manifest);
        } catch (error) {
            console.warn(`[skip] ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
            manifest.failures = manifest.failures.filter(failure => failure.id !== entry.id);
            manifest.failures.push({ id: entry.id, category, message: error instanceof Error ? error.message : String(error) });
            attemptedIds.add(entry.id);
            await saveManifest(manifest);
        }
    }
    if (selected < targetPerCategory) {throw new Error(`Only ${selected}/${targetPerCategory} usable sources for ${category}`);}
}

await saveManifest(manifest);
console.log(`Downloaded ${manifest.samples.length} source projects into ${outputRoot}`);
