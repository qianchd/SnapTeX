/// <reference types="mocha" />

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BibTexParser } from '../bib';
import { LatexDocument } from '../document';
import { DiffEngine } from '../diff';
import { IFileProvider } from '../file-provider';
import { extractMetadata } from '../metadata';
import { isUriWithinAllowedRoots, normalizePdfRequestPath } from '../panel';
import { ProtectionManager } from '../protection';
import { LatexCounterScanner } from '../scanner';
import { LatexBlockSplitter } from '../splitter';
import { SmartRenderer } from '../renderer';
import { cleanLatexCommands, extractAndHideLabels, findCommand, normalizeUri, resolveLatexStyles, stableHash } from '../utils';

class MemoryFileProvider implements IFileProvider {
    constructor(private readonly files: Map<string, string> = new Map()) {}

    async read(uri: vscode.Uri): Promise<string> {
        const content = this.files.get(normalizeUri(uri));
        if (content === undefined) {
            throw new Error(`Missing test file: ${uri.toString()}`);
        }
        return content;
    }

    async readBuffer(uri: vscode.Uri): Promise<Uint8Array> {
        return new TextEncoder().encode(await this.read(uri));
    }

    async exists(uri: vscode.Uri): Promise<boolean> {
        return this.files.has(normalizeUri(uri));
    }

    async stat(uri: vscode.Uri): Promise<{ mtime: number }> {
        return { mtime: this.files.has(normalizeUri(uri)) ? 1 : 0 };
    }

    resolve(base: vscode.Uri, relative: string): vscode.Uri {
        return vscode.Uri.joinPath(base, relative);
    }

    dir(uri: vscode.Uri): vscode.Uri {
        return vscode.Uri.joinPath(uri, '..');
    }
}

function createDocument(
    blockTexts: string[],
    options: {
        macros?: Record<string, string>;
        tikzGlobal?: string;
        title?: string;
        author?: string;
        date?: string;
    } = {}
): LatexDocument {
    const doc = new LatexDocument(new MemoryFileProvider());
    doc.blockTexts = blockTexts;
    doc.blockLines = blockTexts.map((_, index) => index * 3);
    doc.blockLineCounts = blockTexts.map(text => text.split(/\r?\n/).length);
    doc.metadata = {
        macros: options.macros ?? {},
        tikzGlobal: options.tikzGlobal ?? '',
        tikzMacroMap: new Map(),
        title: options.title,
        author: options.author,
        date: options.date
    };
    doc.bibEntries = new Map();
    doc.contentStartLineOffset = 0;
    return doc;
}

function renderBlocks(blockTexts: string[]): string {
    const provider = new MemoryFileProvider();
    const renderer = new SmartRenderer(provider);
    const payload = renderer.render(createDocument(blockTexts));
    assert.equal(payload.type, 'full');
    assert.ok(payload.htmls);
    return payload.htmls.join('');
}

function readFixture(name: string): string {
    return fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', name), 'utf8');
}

suite('DiffEngine', () => {
    test('computes unchanged, insert, delete, and replace spans', () => {
        assert.deepStrictEqual(DiffEngine.compute(['a', 'b'], ['a', 'b']), {
            start: 2,
            deleteCount: 0,
            end: 0,
            insertCount: 0
        });

        assert.deepStrictEqual(DiffEngine.compute(['a', 'c'], ['a', 'b', 'c']), {
            start: 1,
            deleteCount: 0,
            end: 1,
            insertCount: 1
        });

        assert.deepStrictEqual(DiffEngine.compute(['a', 'b', 'c'], ['a', 'c']), {
            start: 1,
            deleteCount: 1,
            end: 1,
            insertCount: 0
        });

        assert.deepStrictEqual(DiffEngine.compute(['a', 'old', 'c'], ['a', 'new', 'c']), {
            start: 1,
            deleteCount: 1,
            end: 1,
            insertCount: 1
        });
    });
});

suite('LatexBlockSplitter', () => {
    test('keeps tikzpicture with internal blank lines as one block', () => {
        const text = [
            '\\begin{tikzpicture}',
            '\\draw (0,0) -- (1,1);',
            '',
            '\\node {A};',
            '\\end{tikzpicture}'
        ].join('\n');

        const blocks = LatexBlockSplitter.split(text);

        assert.equal(blocks.length, 1);
        assert.match(blocks[0].text, /\\begin\{tikzpicture\}/);
        assert.match(blocks[0].text, /\\node \{A\};/);
        assert.match(blocks[0].text, /\\end\{tikzpicture\}/);
    });

    test('splits before major environments but keeps starred floats intact', () => {
        const text = [
            'Before figure.',
            '',
            '\\begin{figure*}',
            '\\caption{Wide}',
            '',
            '\\includegraphics{wide.pdf}',
            '\\end{figure*}',
            '',
            'After figure.'
        ].join('\n');

        const blocks = LatexBlockSplitter.split(text);

        assert.equal(blocks.length, 3);
        assert.equal(blocks[0].text.trim(), 'Before figure.');
        assert.match(blocks[1].text, /\\begin\{figure\*\}/);
        assert.match(blocks[1].text, /\\includegraphics\{wide\.pdf\}/);
        assert.match(blocks[1].text, /\\end\{figure\*\}/);
        assert.equal(blocks[2].text.trim(), 'After figure.');
    });
});

suite('LatexCounterScanner', () => {
    test('numbers regular and starred floats consistently', () => {
        const blocks = [
            '\\begin{figure}\\caption{A}\\label{fig:a}\\end{figure}',
            '\\begin{figure*}\\caption{B}\\label{fig:b}\\end{figure*}',
            '\\begin{table*}\\caption{T}\\label{tbl:t}\\end{table*}',
            '\\begin{algorithm*}\\caption{Alg}\\label{alg:a}\\end{algorithm*}'
        ];

        const result = new LatexCounterScanner().scan(blocks);

        assert.deepStrictEqual(result.blockNumbering[0].counts.fig, ['1']);
        assert.deepStrictEqual(result.blockNumbering[1].counts.fig, ['2']);
        assert.deepStrictEqual(result.blockNumbering[2].counts.tbl, ['1']);
        assert.deepStrictEqual(result.blockNumbering[3].counts.alg, ['1']);
        assert.equal(result.labelMap['fig:a'], '1');
        assert.equal(result.labelMap['fig:b'], '2');
        assert.equal(result.labelMap['tbl:t'], '1');
        assert.equal(result.labelMap['alg:a'], '1');
    });

    test('numbers sections and skips starred equations', () => {
        const blocks = [
            '\\section{Intro}\\label{sec:intro}',
            '\\subsection{Setup}',
            '\\begin{equation}x=1\\label {eq:x}\\end{equation}',
            '\\begin{equation*}y=1\\label{eq:y}\\end{equation*}'
        ];

        const result = new LatexCounterScanner().scan(blocks);

        assert.deepStrictEqual(result.blockNumbering[0].counts.sec, ['1']);
        assert.deepStrictEqual(result.blockNumbering[1].counts.sec, ['1.1']);
        assert.deepStrictEqual(result.blockNumbering[2].counts.eq, ['1']);
        assert.deepStrictEqual(result.blockNumbering[3].counts.eq, []);
        assert.equal(result.labelMap['sec:intro'], '1');
        assert.equal(result.labelMap['eq:x'], '1');
        assert.equal(result.labelMap['eq:y'], undefined);
    });
});

suite('BibTexParser', () => {
    test('parses simple entries with nested brace fields', () => {
        const entries = BibTexParser.parse(`
            @article{smith2024,
              author = {Smith, Jane and Doe, John},
              title = {A {Nested} Title},
              journal = "Journal of Tests",
              year = {2024}
            }
        `);

        const entry = entries.get('smith2024');
        assert.ok(entry);
        assert.equal(entry.type, 'article');
        assert.equal(entry.fields.author, 'Smith, Jane and Doe, John');
        assert.equal(entry.fields.title, 'A {Nested} Title');
        assert.equal(entry.fields.journal, 'Journal of Tests');
        assert.equal(entry.fields.year, '2024');
    });

    test('formats authors with accents and multiple BibTeX name forms', () => {
        const entries = BibTexParser.parse(`
            @article{accented,
              author = {M\\"uller, Ada and John Smith and Jane Doe},
              title = {Title},
              year = {2024}
            }
        `);

        const entry = entries.get('accented');
        assert.ok(entry);
        assert.equal(BibTexParser.getShortAuthor(entry), 'Muller <em>et al.</em>');
    });
});

suite('LaTeX style utilities', () => {
    test('renders common text styles including texttt', () => {
        const html = resolveLatexStyles('\\textbf{B} \\textit{I} \\texttt{T} \\underline{U}');

        assert.match(html, /<strong>B<\/strong>/);
        assert.match(html, /<em>I<\/em>/);
        assert.match(html, /<code>T<\/code>/);
        assert.match(html, /<u>U<\/u>/);
    });

    test('finds nested command content and hides labels with optional whitespace', () => {
        const command = findCommand('\\caption[Short]{A {Nested} Caption}', 'caption');
        assert.ok(command);
        assert.equal(command.content, 'A {Nested} Caption');

        const labels = extractAndHideLabels('Figure body \\label {fig:spaced} text \\label{fig:tight}');
        assert.equal(labels.cleanContent, 'Figure body  text ');
        assert.match(labels.hiddenHtml, /id="fig:spaced"/);
        assert.match(labels.hiddenHtml, /id="fig:tight"/);
    });

    test('cleans common BibTeX LaTeX commands without stripping protected tokens', () => {
        const protector = new ProtectionManager();
        const token = protector.protect('math', '<span>math</span>');
        const cleaned = cleanLatexCommands(`M\\"uller \\textbf{Bold} ${token}`, {
            protect: (namespace: string, content: string) => protector.protect(namespace, content)
        });

        assert.match(cleaned, /M.ller/);
        assert.match(cleaned, /<b>Bold<\/b>/);
        assert.match(protector.resolve(cleaned), /<span>math<\/span>/);
    });
});

suite('LatexDocument source mapping', () => {
    test('maps flattened lines back to included source files', async () => {
        const mainUri = vscode.Uri.file('/project/main.tex');
        const sectionUri = vscode.Uri.file('/project/section1.tex');
        const provider = new MemoryFileProvider(new Map([
            [normalizeUri(mainUri), [
                '\\documentclass{article}',
                '\\begin{document}',
                'Root line',
                '\\input{section1}',
                '\\end{document}'
            ].join('\n')],
            [normalizeUri(sectionUri), [
                'Included line',
                '',
                'Second included block'
            ].join('\n')]
        ]));
        const doc = new LatexDocument(provider);

        const result = await doc.parse(mainUri);
        doc.applyResult(result);

        const flatLine = doc.getFlattenedLine(sectionUri.toString(), 0);
        assert.notEqual(flatLine, -1);
        const original = doc.getOriginalPosition(flatLine);
        assert.ok(original);
        assert.equal(normalizeUri(original.file), normalizeUri(sectionUri));
        assert.equal(original.line, 0);
    });

    test('loads bibliography entries relative to the root document', async () => {
        const mainUri = vscode.Uri.file('/project/main.tex');
        const bibUri = vscode.Uri.file('/project/refs.bib');
        const provider = new MemoryFileProvider(new Map([
            [normalizeUri(mainUri), [
                '\\begin{document}',
                'See \\cite{smith2024}.',
                '\\bibliography{refs}',
                '\\end{document}'
            ].join('\n')],
            [normalizeUri(bibUri), '@article{smith2024, title={Paper}, author={Smith, Jane}, year={2024}}']
        ]));
        const doc = new LatexDocument(provider);

        const result = await doc.parse(mainUri);

        assert.ok(result.bibEntries.has('smith2024'));
        assert.equal(result.bibEntries.get('smith2024')?.fields.title, 'Paper');
        assert.equal(result.contentStartLineOffset, 0);
        assert.equal(result.blockTexts.length, 1);
    });
});

suite('SmartRenderer', () => {
    test('does not emit nested latex-block classes for float internals', () => {
        const html = renderBlocks([
            [
                '\\begin{figure}',
                '\\caption{A figure}',
                '\\includegraphics{plot.png}',
                '\\label{fig:a}',
                '\\end{figure}'
            ].join('\n'),
            [
                '\\begin{table}',
                '\\caption{A table}',
                '\\begin{tabular}{c}',
                'A \\\\',
                '\\end{tabular}',
                '\\label{tbl:a}',
                '\\end{table}'
            ].join('\n'),
            [
                '\\begin{algorithm}',
                '\\caption{A procedure}',
                '\\begin{algorithmic}',
                '\\State x',
                '\\end{algorithmic}',
                '\\label{alg:a}',
                '\\end{algorithm}'
            ].join('\n')
        ]);

        const latexBlockClassCount = html.match(/class="latex-block/g)?.length ?? 0;
        assert.equal(latexBlockClassCount, 3);
        assert.doesNotMatch(html, /class="latex-block figure/);
        assert.doesNotMatch(html, /class="latex-block table/);
        assert.doesNotMatch(html, /class="latex-block algorithm/);
    });

    test('keeps registered preprocess rules sorted by priority', () => {
        const provider = new MemoryFileProvider();
        const renderer = new SmartRenderer(provider);
        renderer.registerPreprocessRule({
            name: 'test-order-second',
            priority: -1000,
            apply: text => `${text}B`
        });
        renderer.registerPreprocessRule({
            name: 'test-order-first',
            priority: -2000,
            apply: text => `${text}A`
        });

        const payload = renderer.render(createDocument(['x']));

        assert.equal(payload.type, 'full');
        assert.ok(payload.htmls?.[0].includes('xAB'));
        assert.ok(!payload.htmls?.[0].includes('xBA'));
    });

    test('returns patch payloads for small localized edits', () => {
        const renderer = new SmartRenderer(new MemoryFileProvider());
        renderer.render(createDocument(['A', 'B', 'C']));

        const payload = renderer.render(createDocument(['A', 'B changed', 'C']));

        assert.equal(payload.type, 'patch');
        assert.equal(payload.start, 1);
        assert.equal(payload.deleteCount, 1);
        assert.equal(payload.htmls?.length, 1);
        assert.match(payload.htmls?.[0] ?? '', /B changed/);
    });

    test('adds block hashes from block text only and disables hash preservation on macro changes', () => {
        const renderer = new SmartRenderer(new MemoryFileProvider());
        const first = renderer.render(createDocument(['$\\foo$'], { macros: { '\\foo': 'x' } }));
        const next = renderer.render(createDocument(['$\\foo$'], { macros: { '\\foo': 'y' } }));

        assert.equal(first.type, 'full');
        assert.equal(next.type, 'full');
        assert.match(first.htmls?.[0] ?? '', new RegExp(`data-block-hash="${stableHash('$\\foo$')}"`));
        assert.match(next.htmls?.[0] ?? '', new RegExp(`data-block-hash="${stableHash('$\\foo$')}"`));
        assert.equal(next.preserveUnchangedBlocks, false);
    });

    test('escapes maketitle metadata while preserving LaTeX formatting', () => {
        const renderer = new SmartRenderer(new MemoryFileProvider());
        const payload = renderer.render(createDocument(['\\maketitle'], {
            title: '<img src=x onerror=alert(1)> \\textbf{Safe} $x<y$',
            author: 'Ada & Bob',
            date: '2026 <script>alert(1)</script>'
        }));
        const html = payload.htmls?.join('') ?? '';

        assert.doesNotMatch(html, /<img/i);
        assert.doesNotMatch(html, /<script/i);
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
        assert.match(html, /Ada &amp; Bob/);
        assert.match(html, /2026 &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.match(html, /<strong>Safe<\/strong>/);
        assert.match(html, /class="katex"/);
    });

    test('updates maketitle metadata without exposing raw metadata in block hashes', () => {
        const renderer = new SmartRenderer(new MemoryFileProvider());
        renderer.render(createDocument(['\\maketitle'], { title: 'First' }));

        const payload = renderer.render(createDocument(['\\maketitle'], { title: 'Second <tag>' }));
        const html = payload.htmls?.join('') ?? '';

        assert.equal(payload.type, 'patch');
        assert.equal(payload.start, 0);
        assert.match(html, /Second &lt;tag&gt;/);
        assert.doesNotMatch(html, /Second <tag>/);
        assert.doesNotMatch(html, /data-block-hash="[^"]*Second/);
    });

    test('uses full render when a replacement edit exceeds the fixed threshold', () => {
        const renderer = new SmartRenderer(new MemoryFileProvider());
        const oldBlocks = Array.from({ length: 300 }, (_, index) => `Block ${index}`);
        const newBlocks = oldBlocks.map((text, index) => index >= 100 && index < 200 ? `${text} changed` : text);
        renderer.render(createDocument(oldBlocks));

        const payload = renderer.render(createDocument(newBlocks));

        assert.equal(payload.type, 'full');
        assert.equal(payload.htmls?.length, 300);
    });

    test('uses full render for very large replacement edits', () => {
        const renderer = new SmartRenderer(new MemoryFileProvider());
        const oldBlocks = Array.from({ length: 300 }, (_, index) => `Block ${index}`);
        const newBlocks = oldBlocks.map((text, index) => index < 220 ? `${text} changed` : text);
        renderer.render(createDocument(oldBlocks));

        const payload = renderer.render(createDocument(newBlocks));

        assert.equal(payload.type, 'full');
        assert.equal(payload.htmls?.length, 300);
    });

    test('forces a full render when macros change', () => {
        const renderer = new SmartRenderer(new MemoryFileProvider());
        renderer.render(createDocument(['$\\foo$'], { macros: { '\\foo': 'x' } }));

        const payload = renderer.render(createDocument(['$\\foo$'], { macros: { '\\foo': 'y' } }));

        assert.equal(payload.type, 'full');
        assert.equal(payload.htmls?.length, 1);
    });

    test('renders figure pdf placeholders and resolves references after numbering', () => {
        const html = renderBlocks([
            '\\section{Intro}\\label{sec:intro} See Section~\\ref{sec:intro}.',
            [
                '\\begin{figure}',
                '\\caption{PDF figure}',
                '\\includegraphics{figures/result.pdf}',
                '\\label{fig:result}',
                '\\end{figure}'
            ].join('\n')
        ]);

        assert.match(html, /class="latex-figure"/);
        assert.match(html, /data-req-path="figures\/result\.pdf"/);
        assert.match(html, /data-key="sec:intro"/);
        assert.equal(html.match(/class="latex-block/g)?.length ?? 0, 2);
    });

    test('unwraps resizebox around protected tikz figures', () => {
        const html = renderBlocks([
            [
                '\\begin{figure}[H]',
                '\\centering',
                '\\resizebox{\\textwidth}{!}{',
                '\\begin{tikzpicture}',
                '\\path coordinate (A) at (0, 0) coordinate (E) at (15, 0);',
                '\\draw[line width=.5pt] (A) -- (E);',
                '\\node[dot, label = {$\\htau_{a}$}] at (A) {};',
                '\\node[dot, label = {$\\htau_{a+1}$}] at (E) {};',
                '\\end{tikzpicture}}',
                '\\end{figure}'
            ].join('\n')
        ]);

        assert.match(html, /class="tikz-container"/);
        assert.match(html, /<script type="text\/snaptex-tikz"/);
        assert.doesNotMatch(html, /\\resizebox/);
    });

    test('injects only TikZ libraries used by each picture', () => {
        const renderer = new SmartRenderer(new MemoryFileProvider());
        const doc = createDocument([
            [
                '\\begin{tikzpicture}',
                '\\path coordinate (A) at (0, 0) coordinate (E) at (15, 0);',
                '\\path coordinate (B) at ($ (A)!.5!(E) $);',
                '\\draw (A) -- (B);',
                '\\node[dot] at (B) {};',
                '\\end{tikzpicture}'
            ].join('\n')
        ], {
            tikzGlobal: [
                '\\usetikzlibrary{calc, shapes.geometric, positioning, decorations.pathreplacing, patterns, arrows.meta, backgrounds, angles}',
                '\\definecolor{brand}{RGB}{1,2,3}',
                '\\tikzset{dot/.style={circle,fill}}',
                '\\tikzset{braceStyle/.style={decorate, decoration={brace}}}',
                '\\tikzset{posStyle/.style={right=of other}}'
            ].join('\n')
        });
        const payload = renderer.render(doc);
        const html = payload.htmls?.join('') ?? '';

        assert.match(html, /\\usetikzlibrary\{calc\}/);
        assert.match(html, /\\definecolor\{brand\}/);
        assert.match(html, /\\tikzset\{dot\/\.style/);
        assert.doesNotMatch(html, /arrows\.meta/);
        assert.doesNotMatch(html, /backgrounds/);
        assert.doesNotMatch(html, /decorations\.pathreplacing/);
        assert.doesNotMatch(html, /patterns/);
        assert.doesNotMatch(html, /shapes\.geometric/);
    });

    test('includes TikZ libraries required by used global styles', () => {
        const renderer = new SmartRenderer(new MemoryFileProvider());
        const doc = createDocument([
            [
                '\\begin{tikzpicture}',
                '\\draw[braceStyle] (0,0) -- (1,0);',
                '\\end{tikzpicture}'
            ].join('\n')
        ], {
            tikzGlobal: [
                '\\usetikzlibrary{calc, decorations.pathreplacing, positioning}',
                '\\tikzset{braceStyle/.style={decorate, decoration={brace}}}',
                '\\tikzset{posStyle/.style={right=of other}}'
            ].join('\n')
        });
        const payload = renderer.render(doc);
        const html = payload.htmls?.join('') ?? '';

        assert.match(html, /\\usetikzlibrary\{decorations\.pathreplacing\}/);
        assert.doesNotMatch(html, /positioning/);
        assert.doesNotMatch(html, /calc/);
    });

    test('renders a fixture-backed long document and keeps localized edits as patches', async () => {
        const mainUri = vscode.Uri.file('/project/long-doc.tex');
        const bibUri = vscode.Uri.file('/project/refs.bib');
        const fixtureText = readFixture('long-doc.tex');
        const files = new Map([
            [normalizeUri(mainUri), fixtureText],
            [normalizeUri(bibUri), '@article{smith2024, title={Fixture Paper}, author={Smith, Jane}, year={2024}}']
        ]);
        const provider = new MemoryFileProvider(files);
        const renderer = new SmartRenderer(provider);
        const firstDoc = new LatexDocument(provider);
        firstDoc.applyResult(await firstDoc.parse(mainUri));

        const fullPayload = renderer.render(firstDoc);

        assert.equal(fullPayload.type, 'full');
        assert.ok((fullPayload.htmls?.length ?? 0) >= 8);
        assert.ok(fullPayload.htmls?.every(html => /data-block-hash="/.test(html)));

        files.set(
            normalizeUri(mainUri),
            fixtureText.replace('The second paragraph contains', 'The revised second paragraph contains')
        );
        const secondDoc = new LatexDocument(provider);
        secondDoc.applyResult(await secondDoc.parse(mainUri));

        const patchPayload = renderer.render(secondDoc);

        assert.equal(patchPayload.type, 'patch');
        assert.equal(patchPayload.htmls?.length, 1);
        assert.match(patchPayload.htmls?.[0] ?? '', /revised second paragraph/);
    });
});

suite('PDF request validation', () => {
    test('normalizes safe relative pdf paths', () => {
        assert.equal(normalizePdfRequestPath('figure.pdf'), 'figure.pdf');
        assert.equal(normalizePdfRequestPath('./figures/Plot.PDF'), 'figures/Plot.PDF');
        assert.equal(normalizePdfRequestPath('figures\\plot.pdf'), 'figures/plot.pdf');
    });

    test('rejects unsafe or unsupported pdf paths', () => {
        assert.equal(normalizePdfRequestPath('../secret.pdf'), undefined);
        assert.equal(normalizePdfRequestPath('figures/../secret.pdf'), undefined);
        assert.equal(normalizePdfRequestPath('/tmp/secret.pdf'), undefined);
        assert.equal(normalizePdfRequestPath('C:/tmp/secret.pdf'), undefined);
        assert.equal(normalizePdfRequestPath('figure.png'), undefined);
        assert.equal(normalizePdfRequestPath(42), undefined);
    });

    test('checks resolved pdf uris against allowed roots', () => {
        const root = vscode.Uri.file('/project');
        const docDir = vscode.Uri.file('/project/chapter');

        assert.equal(isUriWithinAllowedRoots(vscode.Uri.file('/project/chapter/figures/a.pdf'), [docDir, root]), true);
        assert.equal(isUriWithinAllowedRoots(vscode.Uri.file('/project2/a.pdf'), [root]), false);
        assert.equal(isUriWithinAllowedRoots(vscode.Uri.parse('https://example.com/a.pdf'), [root]), false);
    });

    test('keeps PDF loading on the URI-only transport path', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const panelSource = fs.readFileSync(path.join(repoRoot, 'src', 'panel.ts'), 'utf8');
        const webviewSource = fs.readFileSync(path.join(repoRoot, 'media', 'webview.html'), 'utf8');

        assert.doesNotMatch(panelSource, /\bpdfData\b/);
        assert.doesNotMatch(panelSource, /\bbase64\b/i);
        assert.doesNotMatch(panelSource, /\btransport\b/);
        assert.doesNotMatch(webviewSource, /\bpdfData\b/);
        assert.doesNotMatch(webviewSource, /\bbase64\b/i);
        assert.doesNotMatch(webviewSource, /\btransport\b/);
    });

    test('requests viewport-near PDF canvases without waiting for observer scroll events', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = fs.readFileSync(path.join(repoRoot, 'media', 'webview.html'), 'utf8');

        assert.match(webviewSource, /isPdfCanvasNearViewport\(canvas\)/);
        assert.match(webviewSource, /this\.requestPdfCanvas\(canvas\);\s*return;/);
        assert.match(webviewSource, /schedulePendingPdfRender\(\)/);
    });

    test('uses non-streaming PDF.js URL loading for webview resource URIs', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = fs.readFileSync(path.join(repoRoot, 'media', 'webview.html'), 'utf8');

        assert.match(webviewSource, /disableRange:\s*true/);
        assert.match(webviewSource, /disableStream:\s*true/);
        assert.match(webviewSource, /disableAutoFetch:\s*true/);
    });

    test('creates a blob module worker for PDF.js inside the webview sandbox', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = fs.readFileSync(path.join(repoRoot, 'media', 'webview.html'), 'utf8');

        assert.match(webviewSource, /async function setupPdfWorker\(\)/);
        assert.match(webviewSource, /URL\.createObjectURL\(new Blob/);
        assert.match(webviewSource, /new Worker\(workerBlobUrl,\s*\{\s*type:\s*'module'\s*\}\)/);
        assert.match(webviewSource, /pdfjsLib\.GlobalWorkerOptions\.workerPort = worker/);
        assert.match(webviewSource, /await pdfWorkerReady/);
    });

    test('sends full updates as block payloads without building a giant binary html buffer', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const panelSource = fs.readFileSync(path.join(repoRoot, 'src', 'panel.ts'), 'utf8');
        const webviewSource = fs.readFileSync(path.join(repoRoot, 'media', 'webview.html'), 'utf8');

        assert.match(panelSource, /payload\.htmls = payload\.htmls\.map\(h => fixPaths\(h\)\)/);
        assert.match(panelSource, /this\._panel\.webview\.postMessage\(\{ command: 'update', payload \}\)/);
        assert.doesNotMatch(panelSource, /Buffer\.from\(fullHtml\)/);
        assert.doesNotMatch(panelSource, /command: 'update_binary'/);
        assert.match(webviewSource, /smartFullUpdateFromBlocks\(htmls, preserveUnchangedBlocks = true\)/);
        assert.match(webviewSource, /parseBlockHtml\(html\)/);
        assert.match(webviewSource, /this\.smartFullUpdateFromBlocks\(payload\.htmls, payload\.preserveUnchangedBlocks !== false\)/);
    });

    test('releases far-offscreen PDF canvas bitmaps while preserving layout for rerender', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = fs.readFileSync(path.join(repoRoot, 'media', 'webview.html'), 'utf8');

        assert.match(webviewSource, /const PDF_RELEASE_MARGIN = 3600/);
        assert.match(webviewSource, /isPdfCanvasFarFromViewport\(canvas\)/);
        assert.match(webviewSource, /releasePdfCanvasBitmap\(canvas\)/);
        assert.match(webviewSource, /canvas\.style\.height = `\$\{Math\.ceil\(rect\.height\)\}px`/);
        assert.match(webviewSource, /canvas\.width = 0/);
        assert.match(webviewSource, /canvas\.height = 0/);
        assert.match(webviewSource, /canvas\.setAttribute\('data-pdf-released', 'true'\)/);
        assert.match(webviewSource, /canvas\.removeAttribute\('data-rendered'\)/);
        assert.match(webviewSource, /canvas\.removeAttribute\('data-pdf-released'\)/);
    });
});

suite('Webview resource loading', () => {
    test('lazy-loads TikZJax only when TikZ scripts are present', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = fs.readFileSync(path.join(repoRoot, 'media', 'webview.html'), 'utf8');

        assert.doesNotMatch(webviewSource, /<script src="\{\{tikzJaxJsUri\}\}" id="tikzjax-script" defer><\/script>/);
        assert.match(webviewSource, /window\.tikzJaxJsUri = '\{\{tikzJaxJsUri\}\}'/);
        assert.match(webviewSource, /window\.ensureTikzJaxLoaded = function\(\)/);
        assert.match(webviewSource, /script\.src = window\.tikzJaxJsUri/);
        assert.match(webviewSource, /TIKZ_PENDING_SCRIPT_TYPE = 'text\/snaptex-tikz'/);
        assert.match(webviewSource, /window\.activatePendingTikzScripts = function/);
        assert.match(webviewSource, /querySelector\(TIKZ_SCRIPT_SELECTOR\)/);
    });

    test('marks stuck TikZ renders as failed instead of leaving permanent loaders', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = fs.readFileSync(path.join(repoRoot, 'media', 'webview.html'), 'utf8');

        assert.match(webviewSource, /window\.failPendingTikzContainers = function\(message\)/);
        assert.match(webviewSource, /window\.watchPendingTikzContainers = function\(root = document\)/);
        assert.match(webviewSource, /TikZ rendering timed out/);
        assert.match(webviewSource, /svg\[role="img"\]/);
    });

    test('does not timeout TikZ containers while they are only waiting in the TikZJax queue', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = fs.readFileSync(path.join(repoRoot, 'media', 'webview.html'), 'utf8');

        assert.match(webviewSource, /document\.addEventListener\('tikzjax-tex-input'/);
        assert.match(webviewSource, /document\.addEventListener\('tikzjax-load-finished'/);
        assert.match(webviewSource, /window\.failTikzContainer = function\(container, message\)/);
        assert.match(webviewSource, /setTikzContainerState\(container, 'queued'\)/);
        assert.match(webviewSource, /setTikzContainerState\(container, 'rendering'\)/);
        assert.doesNotMatch(webviewSource, /setTimeout\(\(\) => \{[\s\S]*window\.failPendingTikzContainers\('TikZ rendering timed out\.'\)/);
    });

    test('coalesces TikZ activation so edits during a render only queue the latest run', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = fs.readFileSync(path.join(repoRoot, 'media', 'webview.html'), 'utf8');

        assert.match(webviewSource, /const TIKZ_RENDER_DEBOUNCE_MS = 200/);
        assert.match(webviewSource, /class CoalescingTaskScheduler/);
        assert.match(webviewSource, /this\.running = false/);
        assert.match(webviewSource, /this\.pending = true/);
        assert.match(webviewSource, /if \(this\.running\) return/);
        assert.match(webviewSource, /if \(this\.pending\) \{[\s\S]*this\.schedule\(\);[\s\S]*\}/);
        assert.match(webviewSource, /this\.tikzRenderScheduler = new CoalescingTaskScheduler/);
        assert.match(webviewSource, /runTikzRenderBatch\(\)/);
        assert.match(webviewSource, /waitForTikzBatch\(containers\)/);
        assert.match(webviewSource, /TIKZ_BATCH_RENDER_TIMEOUT_MS/);
        assert.match(webviewSource, /setTimeout\(\(\) => \{[\s\S]*resolve\(\);[\s\S]*\}, TIKZ_BATCH_RENDER_TIMEOUT_MS\)/);
        assert.match(webviewSource, /snaptex-tikz-settled/);
        assert.match(webviewSource, /this\.contentRoot\.querySelector\(TIKZ_SCRIPT_SELECTOR\)/);
        assert.match(webviewSource, /this\.getPendingTikzContainers\(this\.contentRoot\)/);
        assert.match(webviewSource, /window\.watchPendingTikzContainers\(this\.contentRoot\)/);
        assert.match(webviewSource, /window\.activatePendingTikzScripts\(this\.contentRoot\)/);
        assert.doesNotMatch(webviewSource, /window\.activatePendingTikzScripts\(document\)/);
        assert.match(webviewSource, /script\.replaceWith\(activeScript\)/);
    });

    test('keeps the previous TikZ SVG visible while a replacement render is pending', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = fs.readFileSync(path.join(repoRoot, 'media', 'webview.html'), 'utf8');
        const styleSource = fs.readFileSync(path.join(repoRoot, 'media', 'preview-style.css'), 'utf8');

        assert.match(webviewSource, /collectTikzPreviews\(block\)/);
        assert.match(webviewSource, /attachStaleTikzPreviews\(block, previews\)/);
        assert.match(webviewSource, /replaceBlockPreservingTikz\(oldBlock, newBlock\)/);
        assert.match(webviewSource, /applyStaleTikzPreviewsToBlock\(newBlock, oldBlock\)/);
        assert.match(webviewSource, /preview\.classList\.add\('tikz-stale-preview'\)/);
        assert.match(webviewSource, /container\.querySelectorAll\('\.tikz-stale-preview'\)\.forEach\(preview => preview\.remove\(\)\)/);
        assert.match(webviewSource, /svg\[role="img"\]:not\(\.tikz-stale-preview\)/);
        assert.match(styleSource, /\.tikz-container\[data-tikz-state="queued"\] > svg:not\(\.tikz-stale-preview\)/);
        assert.match(styleSource, /\.tikz-stale-preview/);
    });

    test('uses block hashes instead of outerHTML to preserve unchanged full-update blocks', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const rendererSource = fs.readFileSync(path.join(repoRoot, 'src', 'renderer.ts'), 'utf8');
        const webviewSource = fs.readFileSync(path.join(repoRoot, 'media', 'webview.html'), 'utf8');

        assert.match(rendererSource, /data-block-hash="\$\{stableHash\(text\)\}"/);
        assert.match(rendererSource, /preserveUnchangedBlocks:\s*!macrosChanged/);
        assert.match(webviewSource, /shouldReplaceBlock\(oldBlock, newBlock, preserveUnchangedBlocks\)/);
        assert.match(webviewSource, /oldBlock\.getAttribute\('data-block-hash'\)/);
        assert.match(webviewSource, /newBlock\.getAttribute\('data-block-hash'\)/);
        assert.match(webviewSource, /this\.smartFullUpdate\(payload\.html, payload\.preserveUnchangedBlocks !== false\)/);
        assert.doesNotMatch(webviewSource, /outerHTML !==/);
    });

    test('keeps shell virtualization prepared behind a disabled experimental setting', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const packageSource = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
        const panelSource = fs.readFileSync(path.join(repoRoot, 'src', 'panel.ts'), 'utf8');
        const webviewSource = fs.readFileSync(path.join(repoRoot, 'media', 'webview.html'), 'utf8');

        assert.match(packageSource, /"snaptex\.experimentalVirtualization"/);
        assert.match(packageSource, /"default": false/);
        assert.match(panelSource, /experimentalVirtualization: config\.get<boolean>\('experimentalVirtualization', false\)/);
        assert.match(webviewSource, /class BlockVirtualizationController/);
        assert.match(webviewSource, /this\.enabled = false/);
        assert.match(webviewSource, /this\.heightCache = new Map\(\)/);
        assert.match(webviewSource, /rememberBlockHeight\(block\)/);
        assert.match(webviewSource, /this\.virtualization\.setEnabled\(event\.data\.config\.experimentalVirtualization === true\)/);
        assert.match(webviewSource, /this\.virtualization\.rememberBlockHeight\(oldBlock\)/);
    });

    test('routes TikZ compile failures through the webview error state', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = fs.readFileSync(path.join(repoRoot, 'media', 'webview.html'), 'utf8');
        const tikzJaxSource = fs.readFileSync(path.join(repoRoot, 'media', 'vendor', 'tikzjax', 'tikzjax.js'), 'utf8');

        assert.match(webviewSource, /document\.addEventListener\('tikzjax-load-failed'/);
        assert.match(webviewSource, /window\.failTikzContainer\(container, message\)/);
        assert.match(tikzJaxSource, /tikzjax-load-failed/);
        assert.match(tikzJaxSource, /new CustomEvent\("tikzjax-load-failed"/);
        assert.doesNotMatch(tikzJaxSource, /invalid\.site\/img-not-found\.png/);
    });

    test('bootstraps dynamic TikZJax with a self-contained blob worker in VS Code webviews', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const buildSource = fs.readFileSync(path.join(repoRoot, 'esbuild.js'), 'utf8');
        const tikzJaxSource = fs.readFileSync(path.join(repoRoot, 'media', 'vendor', 'tikzjax', 'tikzjax.js'), 'utf8');
        const runTexSource = fs.readFileSync(path.join(repoRoot, 'media', 'vendor', 'tikzjax', 'run-tex.js'), 'utf8');
        const calcLibraryPath = path.join(repoRoot, 'media', 'vendor', 'tikzjax', 'tex_files', 'tikzlibrarycalc.code.tex.gz');

        assert.match(buildSource, /patchTikzJaxWorkerBootstrap/);
        assert.match(buildSource, /function replaceOrThrow/);
        assert.match(buildSource, /throw new Error\(`\[build\] TikZJax/);
        assert.doesNotMatch(buildSource, /console\.warn\('\[build\] Warning: TikZJax/);
        assert.doesNotMatch(buildSource, /require\('zlib'\)/);
        assert.match(buildSource, /CORSWorkaround:!1/);
        assert.ok(fs.existsSync(calcLibraryPath));
        assert.match(tikzJaxSource, /fetch\(`\$\{e\}\/run-tex\.js`\)/);
        assert.match(tikzJaxSource, /URL\.createObjectURL\(new Blob/);
        assert.match(tikzJaxSource, /new o\([^,]+,\{CORSWorkaround:!1\}\)/);
        assert.match(tikzJaxSource, /tex_files\/tikzlibrarycalc\.code\.tex\.gz/);
        assert.match(tikzJaxSource, /Promise\.all\(/);
        assert.match(tikzJaxSource, /snaptexAssets\[A\]=await c\(A\)/);
        assert.match(tikzJaxSource, /r\.load\(\{base:e,assets:snaptexAssets\}/);
        assert.match(tikzJaxSource, /!e\.isConnected&&\(!e\.loader\|\|!e\.loader\.isConnected\)/);
        assert.match(tikzJaxSource, /if\(!r\.isConnected\)return/);
        assert.match(tikzJaxSource, /window\.addEventListener\("unload",Z\)/);
        assert.doesNotMatch(tikzJaxSource, /revokeObjectURL[\s\S]*tikzjax-load-finished/);
        assert.doesNotMatch(tikzJaxSource, /new o\(`\$\{e\}\/run-tex\.js`,\{CORSWorkaround:!1\}\)/);
        assert.doesNotMatch(tikzJaxSource, /new o\(`\$\{e\}\/run-tex\.js`\)/);
        assert.doesNotMatch(tikzJaxSource, /try\{await r\.load\(e\)\}catch\(e\)\{console\.log\(e\)\}return r/);
        assert.match(runTexSource, /snaptexAssetUrls&&snaptexAssetUrls\[A\]/);
        assert.match(runTexSource, /snaptexAssetUrls=A&&A\.assets\|\|null/);
    });
});

suite('Metadata extraction', () => {
    test('extracts metadata, macros, TikZ globals, and TikZ macros', () => {
        const result = extractMetadata([
            '\\title{A \\\\ Title}',
            '\\author{Ada}',
            '\\date{\\today}',
            '\\newcommand{\\vect}[1]{\\mathbf{#1}}',
            '\\DeclareMathOperator{\\rank}{rank}',
            '\\usetikzlibrary{arrows.meta}',
            '\\tikzset{box/.style={draw}}',
            '\\newcommand{\\origin}{(0,0)}',
            '\\begin{document}',
            '\\maketitle',
            '$\\vect{x}$',
            '\\begin{tikzpicture}\\draw \\origin -- (1,1);\\end{tikzpicture}',
            '\\end{document}'
        ].join('\n'));

        assert.equal(result.data.title, 'A <br/> Title');
        assert.equal(result.data.author, 'Ada');
        assert.ok(result.data.date);
        assert.equal(result.data.macros['\\vect'], '\\mathbf{#1}');
        assert.equal(result.data.macros['\\rank'], '\\operatorname{rank}');
        assert.match(result.data.tikzGlobal, /\\usetikzlibrary\{arrows\.meta\}/);
        assert.match(result.data.tikzGlobal, /\\tikzset\{box\/.style=\{draw\}\}/);
        assert.equal(result.data.tikzMacroMap.get('\\origin'), '\\def\\origin{(0,0)}');
        assert.doesNotMatch(result.cleanedText, /\\title/);
        assert.doesNotMatch(result.cleanedText, /\\author/);
    });
});

suite('ProtectionManager', () => {
    test('resolves bare, paragraph-wrapped, and nested tokens', () => {
        const protector = new ProtectionManager();
        const inner = protector.protect('inner', '<span>inner</span>');
        const outer = protector.protect('outer', `<div>${inner}</div>`);

        assert.equal(protector.resolve(`<p>${outer}</p>`), '<div><span>inner</span></div>');
    });

    test('reset clears old tokens and restarts ids', () => {
        const protector = new ProtectionManager();
        const token = protector.protect('x', '<b>x</b>');
        protector.reset();

        assert.equal(protector.resolve(token), token);
        assert.equal(protector.protect('x', '<b>new</b>'), 'XSNAP:x:0Y');
    });
});

suite('URI normalization', () => {
    test('lowercases Windows file uris for stable comparisons', () => {
        const uri = vscode.Uri.file('C:/Project/Section.tex');
        assert.equal(normalizeUri(uri), '/c:/project/section.tex');
    });

    test('preserves case for remote uris', () => {
        const uri = vscode.Uri.parse('vscode-remote://ssh-remote+Host/home/User/Section.tex');
        assert.equal(normalizeUri(uri), 'vscode-remote://ssh-remote+host/home/User/Section.tex');
        assert.equal(
            normalizeUri('vscode-remote://ssh-remote+Host/home/User/Section.tex'),
            'vscode-remote://ssh-remote+Host/home/User/Section.tex'
        );
    });
});
