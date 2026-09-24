const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const api = require(path.resolve(process.argv[2]));
const corpusRoot = path.resolve(process.argv[3] ?? 'tex_samplecode');
const manifest = JSON.parse(fs.readFileSync(path.join(corpusRoot, 'manifest.json'), 'utf8'));
const reportPath = path.join(corpusRoot, 'audit-results.json');

class FileProvider {
    async read(uri) { return fs.promises.readFile(String(uri), 'utf8'); }
    async exists(uri) { try { await fs.promises.access(String(uri)); return true; } catch { return false; } }
    async stat(uri) { return {mtime: (await fs.promises.stat(String(uri))).mtimeMs}; }
    resolve(base, relativePath) { return path.resolve(String(base), relativePath); }
    dir(uri) { return path.dirname(String(uri)); }
}

const countMatches = (text, pattern) => [...text.matchAll(pattern)].length;
const unique = values => [...new Set(values)].sort();

function stripGeneratedSource(html) {
    return html
        .replace(/<annotation\b[\s\S]*?<\/annotation>/gi, '')
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&(?:#\d+|#x[\da-f]+|[a-z]+);/gi, ' ');
}

function decodeHtml(value) {
    return value
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function collectFeatures(text) {
    const clean = api.stripLatexComments(text);
    return {
        commands: unique([...clean.matchAll(/\\([A-Za-z@]+|.)/g)].map(match => match[1])),
        environments: unique([...clean.matchAll(/\\begin\s*\{([^{}]+)\}/g)].map(match => match[1])),
        macros: unique([
            ...[...clean.matchAll(/\\(?:newcommand|renewcommand|providecommand)\*?\s*\{?\\([A-Za-z@]+)/g)].map(match => match[1]),
            ...[...clean.matchAll(/\\def\s*\\([A-Za-z@]+)/g)].map(match => match[1]),
            ...[...clean.matchAll(/\\DeclareMathOperator\*?\s*\{\\([A-Za-z@]+)\}/g)].map(match => match[1])
        ]),
        packages: unique([...clean.matchAll(/\\usepackage(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g)]
            .flatMap(match => match[1].split(',').map(value => value.trim())).filter(Boolean)),
        documentClasses: unique([...clean.matchAll(/\\documentclass(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g)]
            .map(match => match[1].trim()).filter(Boolean))
    };
}

function mergeFeatures(features) {
    return {
        commands: unique(features.flatMap(value => value.commands)),
        environments: unique(features.flatMap(value => value.environments)),
        macros: unique(features.flatMap(value => value.macros)),
        packages: unique(features.flatMap(value => value.packages)),
        documentClasses: unique(features.flatMap(value => value.documentClasses))
    };
}

function summarizeHtml(html) {
    const errorSpans = [...html.matchAll(/<span\b([^>]*)class="[^"]*katex-error[^"]*"([^>]*)>([\s\S]*?)<\/span>/gi)];
    const errorDetails = errorSpans.map(match => {
        const attributes = `${match[1]} ${match[2]}`;
        return {
            title: decodeHtml(attributes.match(/\btitle="([^"]*)"/i)?.[1] ?? ''),
            source: stripGeneratedSource(match[3]).trim()
        };
    });
    const errorSources = unique(errorDetails.map(error => error.source).filter(Boolean));
    const visible = stripGeneratedSource(html.replace(/<span\b[^>]*class="[^"]*katex-error[^"]*"[^>]*>[\s\S]*?<\/span>/gi, ''));
    const rawCommands = unique([...visible.matchAll(/\\([A-Za-z@]+)\b/g)].map(match => match[1]));
    const rawEnvironments = unique([...visible.matchAll(/\\(?:begin|end)\s*\{([^{}]+)\}/g)].map(match => match[1]));
    return {
        htmlBytes: Buffer.byteLength(html),
        visibleChars: visible.replace(/\s+/g, ' ').trim().length,
        katexErrors: errorSpans.length,
        mathErrors: countMatches(html, />Math Error</g),
        unresolvedCitations: countMatches(visible, /\[[A-Za-z][^\]\n]{0,80}\?\]/g),
        rawCommands,
        rawEnvironments,
        katexErrorDetails: errorDetails.slice(0, 40),
        errorSources: errorSources.slice(0, 20)
    };
}

async function renderSample(sample, mode) {
    const root = path.join(corpusRoot, sample.folder, sample.root);
    const source = await fs.promises.readFile(root, 'utf8');
    const service = new api.PreviewUpdateService(new FileProvider());
    const logs = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...values) => logs.push({level: 'warn', message: values.map(String).join(' ')});
    console.error = (...values) => logs.push({level: 'error', message: values.map(String).join(' ')});
    try {
        const startedAt = performance.now();
        const payload = await service.render(root, source, {deferFullHtml: true, backendMode: mode});
        const parseMs = performance.now() - startedAt;
        const htmlParts = [];
        const failures = [];
        const renderStartedAt = performance.now();
        for (let index = 0; index < payload.blocks.length; index++) {
            try {
                const rendered = await service.renderBlockByIndex(index);
                if (rendered?.html) {htmlParts.push(rendered.html);}
                else {failures.push({index, message: 'No block HTML returned'});}
            } catch (error) {
                failures.push({index, message: error instanceof Error ? error.message : String(error)});
            }
        }
        const html = htmlParts.join('\n');
        return {
            blocks: payload.blocks.length,
            parseMs,
            renderMs: performance.now() - renderStartedAt,
            diagnostics: service.getDiagnostics().map(diagnostic => diagnostic.message),
            logs,
            renderFailures: failures,
            ...summarizeHtml(html)
        };
    } finally {
        console.warn = originalWarn;
        console.error = originalError;
    }
}

async function sourceFeatures(sample) {
    const folder = path.join(corpusRoot, sample.folder);
    const texFiles = [];
    async function walk(current) {
        for (const entry of await fs.promises.readdir(current, {withFileTypes: true})) {
            const child = path.join(current, entry.name);
            if (entry.isDirectory()) {await walk(child);}
            else if (entry.isFile() && /\.(?:tex|ltx|latex)$/i.test(entry.name)) {texFiles.push(child);}
        }
    }
    await walk(folder);
    const features = [];
    for (const file of texFiles) {
        try { features.push(collectFeatures(await fs.promises.readFile(file, 'utf8'))); } catch { /* unreadable auxiliary source */ }
    }
    return mergeFeatures(features);
}

function resultSeverity(result) {
    if (result.error || result.renderFailures?.length) {return 4;}
    if (result.mathErrors || result.katexErrors) {return 3;}
    if (result.rawEnvironments.length) {return 2;}
    if (result.rawCommands.length || result.unresolvedCitations) {return 1;}
    return 0;
}

(async () => {
    const previous = process.argv.includes('--resume') && fs.existsSync(reportPath)
        ? JSON.parse(fs.readFileSync(reportPath, 'utf8'))
        : {samples: []};
    const byId = new Map(previous.samples.map(sample => [sample.id, sample]));
    let completed = 0;
    for (const sample of manifest.samples) {
        const existing = byId.get(sample.id);
        if (existing?.legacy && existing?.ast) {
            completed += 1;
            continue;
        }
        const result = {...sample, source: await sourceFeatures(sample)};
        for (const [key, mode] of [['legacy', 'legacy'], ['ast', 'ast(experimental)']]) {
            try {
                result[key] = await renderSample(sample, mode);
                result[key].severity = resultSeverity(result[key]);
            } catch (error) {
                result[key] = {error: error instanceof Error ? error.stack ?? error.message : String(error), severity: 4};
            }
        }
        byId.set(sample.id, result);
        completed += 1;
        const report = {generatedAt: new Date().toISOString(), sampleCount: manifest.samples.length, completed, samples: [...byId.values()]};
        fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        console.log(`[${completed}/${manifest.samples.length}] ${sample.id} legacy=${result.legacy.severity} ast=${result.ast.severity}`);
    }

    const report = {generatedAt: new Date().toISOString(), sampleCount: manifest.samples.length, completed, samples: [...byId.values()]};
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Audit written to ${reportPath}`);
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
