import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

// Use the production client and worker; private documents are never copied.
const root = fileURLToPath(new URL('../..', import.meta.url));
const { PdfSync } = createRequire(import.meta.url)(resolve(root, 'out/apps/standalone/src/pdf-sync.js'));
const entry = resolve(root, 'out/apps/standalone/src/pdf-sync-worker.js');
globalThis.Worker = class extends Worker {
    constructor() {
        super(`const {parentPort}=require('node:worker_threads');
            globalThis.self={postMessage:data=>parentPort.postMessage(data)};
            require(${JSON.stringify(entry)});parentPort.on('message',data=>self.onmessage({data}));`, { eval: true });
        this.on('message', data => this.onmessage?.({ data }));
        this.on('error', error => this.onerror?.({ message: error.message }));
    }
};
const pdf = resolve(process.argv[2]);
const project = resolve(process.argv[3] || dirname(pdf));
const pdfPath = '/' + relative(project, pdf).replaceAll('\\', '/');
const paths = [];
const queries = [];
const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) visit(path);
        else if (entry.isFile() && /\.tex$/i.test(entry.name)) {
            const sourcePath = '/' + relative(project, path).replaceAll('\\', '/');
            paths.push(sourcePath);
            const lines = readFileSync(path, 'utf8').split('\n').length;
            for (let line = 1; line <= lines; line += Math.max(1, Math.floor(lines / 100))) {
                queries.push({ direction: 'forward', sourcePath, line, column: 1 });
            }
        }
    }
};
visit(project);
if (!queries.length) throw new Error('No TeX sources found.');
const data = new Uint8Array(readFileSync(pdf.replace(/\.pdf$/i, '.synctex.gz')));
const start = performance.now();
const sync = new PdfSync(new URL('file:///node-worker'), Promise.resolve({
    runtimeUrl: pathToFileURL(resolve(root, 'apps/standalone/vendor/synctex/synctex.mjs')).href,
    data, compressed: true, pdfPath, rootPath: pdfPath.replace(/\.pdf$/i, '.tex'), paths
}));
try {
    await sync.query(queries[0]);
    const loadAndFirstQueryMs = performance.now() - start;
    const points = [];
    for (const query of queries) {
        const point = await sync.query(query);
        if (point) points.push(point);
    }
    if (!points.length) throw new Error('No source locations mapped.');
    const measure = async queries => {
        const times = [];
        for (let n = 0; n < 1000; n++) {
            const start = performance.now();
            await sync.query(queries[n % queries.length]);
            times.push(performance.now() - start);
        }
        times.sort((a, b) => a - b);
        return { p50: times[500], p95: times[950], max: times.at(-1) };
    };
    console.log(JSON.stringify({ document: basename(pdf), mappedSamples: points.length, loadAndFirstQueryMs,
        forwardMs: await measure(queries), inverseMs: await measure(points.map(point => ({ direction: 'inverse', ...point }))) }, null, 2));
} finally {sync.close();}
