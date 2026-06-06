/// <reference types="mocha" />

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LatexDocument } from '../document';
import { getVirtualMode, isUriWithinAllowedRoots, normalizePdfRequestPath } from '../panel';
import { SmartRenderer } from '../renderer';
import { optimizeTikzPreviewSource, TIKZ_PREVIEW_LOWERINGS } from '../tikz-preview-optimizer';
import { normalizeUri, stableHash } from '../utils';
import {
    createDocument,
    MemoryFileProvider,
    readFixture,
    readWebviewRuntimeSource,
    renderBlocks,
    resultBlockTexts
} from './test-helpers';

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
        assert.equal(result.blockSpans.length, 1);
    });

    test('exposes block text through an accessor for future span-backed storage', () => {
        const doc = createDocument(['First block', 'Second block']);

        assert.equal(doc.getBlockCount(), 2);
        assert.equal(doc.getBlockText(0), 'First block');
        assert.equal(doc.getBlockText(1), 'Second block');
        assert.equal(doc.getBlockText(2), undefined);
        assert.equal(doc.getBlockHash(0), stableHash('First block'));

        doc.releaseTextContent();
        assert.equal(doc.getBlockCount(), 0);
        assert.equal(doc.getBlockText(0), undefined);
        assert.equal(doc.getBlockHash(0), undefined);
    });

    test('stores parsed blocks as body spans and hashes', async () => {
        const mainUri = vscode.Uri.file('/project/main.tex');
        const provider = new MemoryFileProvider(new Map([
            [normalizeUri(mainUri), [
                '\\begin{document}',
                'First paragraph.',
                '',
                'Second paragraph with \\label{p:two}.',
                '\\end{document}'
            ].join('\n')]
        ]));
        const doc = new LatexDocument(provider);

        const result = await doc.parse(mainUri);
        doc.applyResult(result);

        assert.deepStrictEqual(resultBlockTexts(result).map(block => block.trim()), [
            'First paragraph.',
            'Second paragraph with \\label{p:two}.'
        ]);
        assert.deepStrictEqual(result.blockHashes, resultBlockTexts(result).map(text => stableHash(text)));
        assert.equal(doc.getBlockText(1)?.trim(), 'Second paragraph with \\label{p:two}.');
    });

    test('drops comment-only blocks without leaving preview gaps', async () => {
        const mainUri = vscode.Uri.file('/project/main.tex');
        const provider = new MemoryFileProvider(new Map([
            [normalizeUri(mainUri), [
                '\\begin{document}',
                'Before the active derivation.',
                '',
                '%A direct approach is to incorporate CV within the model estimation step.',
                '%\\begin{align}\\label{eq:commented}',
                '%    x = y',
                '%\\end{align}',
                '%More commented explanation.',
                '',
                'Notice that this paragraph should follow without a blank preview block.',
                '',
                '\\begin{align}',
                'x &= y \\label{eq:real}',
                '\\end{align}',
                '%\\begin{equation*}',
                '%    z = 1',
                '%\\end{equation*}',
                'In Eq.~\\eqref{eq:real}, the real paragraph should remain.',
                '\\end{document}'
            ].join('\n')]
        ]));
        const doc = new LatexDocument(provider);

        const result = await doc.parse(mainUri);
        doc.applyResult(result);
        const html = new SmartRenderer().render(doc).htmls?.join('') ?? '';
        const blocks = resultBlockTexts(result);
        const withoutComments = (text: string) => text
            .split(/\r?\n/)
            .map(line => {
                const commentStart = line.search(/(?<!\\)%/);
                return commentStart === -1 ? line : line.substring(0, commentStart);
            })
            .join('\n')
            .trim();

        assert.ok(blocks.every(block => withoutComments(block).length > 0));
        assert.ok(blocks.some(block => block.includes('Notice that this paragraph')));
        assert.ok(blocks.some(block => block.includes('In Eq.~\\eqref{eq:real}')));
        assert.doesNotMatch(blocks.join('\n'), /eq:commented/);
        assert.match(html, /Notice that this paragraph/);
        assert.match(html, /In Eq\./);
        assert.doesNotMatch(html, /eq:commented|%\\begin|<div class="latex-block"[^>]*>\s*<\/div>/);
    });

    test('drops standalone list boundary blocks without leaving preview gaps', async () => {
        const mainUri = vscode.Uri.file('/project/main.tex');
        const provider = new MemoryFileProvider(new Map([
            [normalizeUri(mainUri), [
                '\\begin{document}',
                '\\begin{itemize}',
                '    \\item First item with continuation text.',
                '',
                '\\item Second item after a paragraph break.',
                '',
                '    \\item Third item before the list closes.',
                '',
                '\\end{itemize}',
                '',
                'The next paragraph should follow the list without a blank preview block.',
                '\\end{document}'
            ].join('\n')]
        ]));
        const doc = new LatexDocument(provider);

        const result = await doc.parse(mainUri);
        doc.applyResult(result);
        const html = new SmartRenderer().render(doc).htmls?.join('') ?? '';
        const blocks = resultBlockTexts(result);

        assert.ok(blocks.some(block => block.includes('First item')));
        assert.ok(blocks.some(block => block.includes('Second item')));
        assert.ok(blocks.some(block => block.includes('Third item')));
        assert.ok(blocks.some(block => block.includes('The next paragraph')));
        assert.ok(blocks.every(block => block.trim() !== '\\end{itemize}'));
        assert.doesNotMatch(html, /<div class="latex-block"[^>]*>\s*<\/div>/);
        assert.match(html, /The next paragraph should follow the list/);
    });

    test('inlines standalone TikZ inputs without treating their document end as the root end', async () => {
        const mainUri = vscode.Uri.file('/project/main.tex');
        const figureUri = vscode.Uri.file('/project/figures/fold_illus_reliever.tex');
        const provider = new MemoryFileProvider(new Map([
            [normalizeUri(mainUri), [
                '\\documentclass{article}',
                '\\begin{document}',
                'Before figure.',
                '\\begin{figure}[t]',
                '\\centering',
                '\\resizebox{\\linewidth}{!}{%',
                '\\input{figures/fold_illus_reliever.tex}',
                '}',
                '\\label{fig:illus_reliever}',
                '\\end{figure}',
                'After figure should remain.',
                '\\end{document}'
            ].join('\n')],
            [normalizeUri(figureUri), readFixture('fold_illus_reliever.tex')]
        ]));
        const doc = new LatexDocument(provider);

        const result = await doc.parse(mainUri);
        doc.applyResult(result);
        const joinedBlocks = resultBlockTexts(result).join('\n');
        const html = new SmartRenderer().render(doc).htmls?.join('') ?? '';
        const visibleHtml = html.replace(/<script type="text\/snaptex-tikz"[\s\S]*?<\/script>/g, '');

        assert.match(joinedBlocks, /After figure should remain/);
        assert.doesNotMatch(joinedBlocks, /\\documentclass\[tikz/);
        assert.doesNotMatch(joinedBlocks, /\\end\{document\}/);
        assert.match(result.metadata.tikzGlobal, /\\usetikzlibrary\{[^}]*patterns[^}]*arrows\.meta[^}]*\}/);
        assert.match(result.metadata.tikzGlobal, /\\definecolor\{col1\}/);
        assert.match(result.metadata.tikzMacroMap.get('\\legendBox') ?? '', /\\def\\legendBox#1/);
        assert.match(html, /type="text\/snaptex-tikz"/);
        assert.match(html, /After figure should remain/);
        assert.doesNotMatch(html, /\\newcommand\{\\legendBox\}/);
        assert.doesNotMatch(visibleHtml, /\\begin\{tikzpicture\}/);
        assert.doesNotMatch(visibleHtml, /\\node at/);
        assert.doesNotMatch(visibleHtml, /\\begin\{figure\}/);
        assert.doesNotMatch(visibleHtml, /\\resizebox/);
        assert.doesNotMatch(visibleHtml, /\\end\{figure\}/);
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

    test('renders tabularx tables with booktabs and colored captions', () => {
        const html = renderBlocks([
            [
                '\\begin{table}[!ht]',
                '\\centering',
                '\\caption{\\textcolor{red}{Summary of loss notation. Here, $\\ell$ denotes individual loss.}}',
                '\\label{tab:notation_loss}',
                '\\begin{tabularx}{\\textwidth}{llX}',
                '\\toprule',
                '\\textbf{Notation} & \\textbf{Definition} & \\textbf{Description} \\\\',
                '\\midrule',
                '$\\ell(\\z_i; \\f)$ & -- & {Individual} loss of model $\\f$ at index $i$. \\\\',
                '$\\overline{\\ell}_i(\\f)$ & $\\Ebb[\\ell(\\z_i; \\f)]$ & Expected {individual} loss of \\emph{fixed} model $\\f$ at index $i$. \\\\',
                '\\bottomrule',
                '\\end{tabularx}',
                '\\end{table}'
            ].join('\n')
        ]);

        assert.match(html, /class="latex-table"/);
        assert.match(html, /id="tab:notation_loss"/);
        assert.match(html, /<span style="color: red">Summary of loss notation/);
        assert.match(html, /<table class="latex-tabular-preview latex-tabular-booktabs">/);
        assert.match(html, /<thead><tr><th scope="col"><strong>Notation<\/strong><\/th>/);
        assert.match(html, /<tbody><tr><td>.*Expected individual loss of <em>fixed<\/em> model/s);
        assert.doesNotMatch(html, /border: 1px solid/);
        assert.doesNotMatch(html, /\\begin\{tabularx\}|\\toprule|\\bottomrule/);
    });

    test('renders plain hline tables without markdown-style grid borders', () => {
        const html = renderBlocks([
            [
                '\\begin{table}',
                '\\caption{Plain table}',
                '\\begin{tabular}{lr}',
                '\\hline',
                '\\textbf{Name} & \\textbf{Value} \\\\',
                '\\hline',
                'Alpha & 10 \\\\',
                'Beta & 20 \\\\',
                '\\hline',
                '\\end{tabular}',
                '\\end{table}'
            ].join('\n')
        ]);

        assert.match(html, /<table class="latex-tabular-preview latex-tabular-ruled">/);
        assert.match(html, /<thead><tr><th scope="col"><strong>Name<\/strong><\/th><th scope="col"><strong>Value<\/strong><\/th><\/tr><\/thead>/);
        assert.match(html, /<tbody><tr><td>Alpha<\/td><td>10<\/td><\/tr>/);
        assert.doesNotMatch(html, /border: 1px solid/);
    });

    test('removes standalone comment lines without creating blank preview gaps', () => {
        const html = renderBlocks([
            [
                'aaa.',
                '% bbb',
                '    % ccc',
                '% ddd',
                'eee.'
            ].join('\n')
        ]);

        assert.match(html, /aaa\.\neee\./);
        assert.doesNotMatch(html, /bbb|ccc|ddd|<div class="latex-block"[^>]*>\s*<\/div>/);
    });

    test('keeps registered preprocess rules sorted by priority', () => {
        const renderer = new SmartRenderer();
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

    test('keeps preprocess rules behind a narrow render context', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const rulesSource = fs.readFileSync(path.join(repoRoot, 'src', 'rules.ts'), 'utf8');
        const typesSource = fs.readFileSync(path.join(repoRoot, 'src', 'types.ts'), 'utf8');
        const rendererSource = fs.readFileSync(path.join(repoRoot, 'src', 'renderer.ts'), 'utf8');

        assert.doesNotMatch(rulesSource, /from '\.\/renderer'/);
        assert.match(typesSource, /export interface RenderContext/);
        assert.match(typesSource, /apply: \(text: string, renderer: RenderContext\) => string/);
        assert.match(rendererSource, /doc\.getBlockText\(index\)/);
        assert.doesNotMatch(rendererSource, /lastBlockTexts/);
    });

    test('uses explicit HTML protection in rule modules', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const ruleSource = [
            'rules.ts',
            'rule-floats.ts',
            'rule-tikz.ts',
            'rule-helpers.ts'
        ].map(file => fs.readFileSync(path.join(repoRoot, 'src', file), 'utf8')).join('\n');

        assert.match(ruleSource, /protectHtml\(/);
        assert.doesNotMatch(ruleSource, /\.\s*protect\(/);
    });

    test('returns patch payloads for small localized edits', () => {
        const renderer = new SmartRenderer();
        renderer.render(createDocument(['A', 'B', 'C']));

        const payload = renderer.render(createDocument(['A', 'B changed', 'C']));

        assert.equal(payload.type, 'patch');
        assert.equal(payload.start, 1);
        assert.equal(payload.deleteCount, 1);
        assert.equal(payload.htmls?.length, 1);
        assert.match(payload.htmls?.[0] ?? '', /B changed/);
    });

    test('reads only changed block text for localized hash patches', () => {
        const renderer = new SmartRenderer();
        renderer.render(createDocument(['A', 'B', 'C']));

        const nextDoc = createDocument(['A', 'B changed', 'C']);
        const reads: number[] = [];
        const getBlockText = nextDoc.getBlockText.bind(nextDoc);
        nextDoc.getBlockText = (index: number) => {
            reads.push(index);
            return getBlockText(index);
        };

        const payload = renderer.render(nextDoc);

        assert.equal(payload.type, 'patch');
        assert.deepStrictEqual(reads, [1]);
    });

    test('updates citation order from cached block metadata without rescanning all text', () => {
        const renderer = new SmartRenderer();
        renderer.render(createDocument([
            'See \\cite{smith2024}.',
            'Middle text.',
            '\\bibliography{refs}'
        ]));

        const nextDoc = createDocument([
            'See \\cite{doe2025}.',
            'Middle text.',
            '\\bibliography{refs}'
        ]);
        const reads: number[] = [];
        const getBlockText = nextDoc.getBlockText.bind(nextDoc);
        nextDoc.getBlockText = (index: number) => {
            reads.push(index);
            return getBlockText(index);
        };

        const payload = renderer.render(nextDoc);

        assert.equal(payload.type, 'patch');
        assert.deepStrictEqual(reads, [0]);
        assert.ok(payload.dirtyBlocks?.[2]);
        assert.deepStrictEqual(renderer.citedKeys, ['doe2025']);
    });

    test('adds block hashes from block text only and disables hash preservation on macro changes', () => {
        const renderer = new SmartRenderer();
        const first = renderer.render(createDocument(['$\\foo$'], { macros: { '\\foo': 'x' } }));
        const next = renderer.render(createDocument(['$\\foo$'], { macros: { '\\foo': 'y' } }));

        assert.equal(first.type, 'full');
        assert.equal(next.type, 'full');
        assert.match(first.htmls?.[0] ?? '', new RegExp(`data-block-hash="${stableHash('$\\foo$')}"`));
        assert.match(next.htmls?.[0] ?? '', new RegExp(`data-block-hash="${stableHash('$\\foo$')}"`));
        assert.equal(next.preserveUnchangedBlocks, false);
    });

    test('can defer full HTML and render block HTML on demand', () => {
        const renderer = new SmartRenderer();
        const payload = renderer.render(createDocument([
            'See Figure~\\ref{fig:a} and \\cite{smith2024}.',
            '\\begin{figure}\\caption{A}\\label{fig:a}\\end{figure}',
            '\\bibliography{refs}'
        ]), { deferFullHtml: true });

        assert.equal(payload.type, 'full');
        assert.equal(payload.htmls, undefined);
        assert.equal(payload.blocks?.length, 3);
        assert.deepStrictEqual(payload.blocks?.map(block => block.index), [0, 1, 2]);
        assert.equal(payload.blocks?.[1].hash, stableHash('\\begin{figure}\\caption{A}\\label{fig:a}\\end{figure}'));
        assert.deepStrictEqual(payload.blocks?.[1].anchors, ['fig:a']);
        assert.ok(payload.blocks?.[2].anchors.includes('ref-smith2024'));
        assert.match(renderer.renderBlockByIndex(1) ?? '', /data-index="1"/);
        assert.match(renderer.renderBlockByIndex(1) ?? '', new RegExp(`data-block-hash="${stableHash('\\begin{figure}\\caption{A}\\label{fig:a}\\end{figure}')}"`));
    });

    test('escapes maketitle metadata while preserving LaTeX formatting', () => {
        const renderer = new SmartRenderer();
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

    test('escapes raw source HTML while preserving generated preview HTML', () => {
        const html = renderBlocks([
            'Plain <img src=x onerror=alert(1)> and \\textbf{bold}.',
            '\\begin{theorem}<script>alert(1)</script> and \\emph{safe}.\\end{theorem}'
        ]);

        assert.doesNotMatch(html, /<img|<script/i);
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
        assert.match(html, /<strong>bold<\/strong>/);
        assert.match(html, /class="latex-theorem"/);
        assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.match(html, /<em>safe<\/em>/);
    });

    test('does not trust KaTeX HTML-producing commands by default', () => {
        const html = renderBlocks(['$\\href{javascript:alert(1)}{bad}$']);

        assert.doesNotMatch(html, /href="javascript:alert/i);
    });

    test('renders safe LaTeX href and url commands as protected external links', () => {
        const html = renderBlocks([
            'See \\href{https://example.com/path?q=1&lang=en}{SnapTeX \\textbf{site}} and \\url{https://snaptex.dev/docs?a=1&b=2}.'
        ]);

        assert.match(html, /<a href="https:\/\/example\.com\/path\?q=1&amp;lang=en" class="latex-link latex-href" target="_blank" rel="noopener noreferrer">SnapTeX <strong>site<\/strong><\/a>/);
        assert.match(html, /<a href="https:\/\/snaptex\.dev\/docs\?a=1&amp;b=2" class="latex-link latex-url" target="_blank" rel="noopener noreferrer">https:\/\/snaptex\.dev\/docs\?a=1&amp;b=2<\/a>/);
        assert.doesNotMatch(html, /\\href|\\url/);
    });

    test('drops unsafe LaTeX href and url targets while keeping escaped text', () => {
        const html = renderBlocks([
            '\\href{javascript:alert(1)}{bad <script>alert(1)</script>} \\url{javascript:alert(2)}'
        ]);

        assert.doesNotMatch(html, /href="javascript:alert/i);
        assert.doesNotMatch(html, /\\href|\\url/);
        assert.match(html, /bad &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.match(html, /javascript:alert\(2\)/);
    });

    test('keeps numbered display math containers protected under raw-HTML-disabled Markdown', () => {
        const html = renderBlocks(['\\begin{equation}\\label{obj:inSample}x=1\\end{equation}']);

        assert.match(html, /<div class="equation-container"/);
        assert.match(html, /<span class="eq-no"/);
        assert.match(html, /id="obj:inSample"/);
        assert.doesNotMatch(html, /&lt;div class=&quot;equation-container/);
        assert.doesNotMatch(html, /&lt;span class=&quot;eq-no/);
    });

    test('updates maketitle metadata without exposing raw metadata in block hashes', () => {
        const renderer = new SmartRenderer();
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
        const renderer = new SmartRenderer();
        const oldBlocks = Array.from({ length: 300 }, (_, index) => `Block ${index}`);
        const newBlocks = oldBlocks.map((text, index) => index >= 100 && index < 200 ? `${text} changed` : text);
        renderer.render(createDocument(oldBlocks));

        const payload = renderer.render(createDocument(newBlocks));

        assert.equal(payload.type, 'full');
        assert.equal(payload.htmls?.length, 300);
    });

    test('uses full render for very large replacement edits', () => {
        const renderer = new SmartRenderer();
        const oldBlocks = Array.from({ length: 300 }, (_, index) => `Block ${index}`);
        const newBlocks = oldBlocks.map((text, index) => index < 220 ? `${text} changed` : text);
        renderer.render(createDocument(oldBlocks));

        const payload = renderer.render(createDocument(newBlocks));

        assert.equal(payload.type, 'full');
        assert.equal(payload.htmls?.length, 300);
    });

    test('forces a full render when macros change', () => {
        const renderer = new SmartRenderer();
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

    test('escapes includegraphics paths before inserting them into attributes', () => {
        const html = renderBlocks([
            [
                '\\begin{figure}',
                '\\includegraphics{figures/a" onerror="alert(1).pdf}',
                '\\includegraphics{figures/b" onload="alert(1).png}',
                '\\end{figure}'
            ].join('\n')
        ]);

        assert.match(html, /data-req-path="figures\/a&quot; onerror=&quot;alert\(1\)\.pdf"/);
        assert.match(html, /src="LOCAL_IMG:figures\/b&quot; onload=&quot;alert\(1\)\.png"/);
        assert.doesNotMatch(html, /\s(?:onerror|onload)="/i);
    });

    test('renders reference and citation edge cases', () => {
        const doc = createDocument([
            [
                '\\section{Intro}\\label{sec:intro}',
                'See \\ref{sec:intro,fig:missing}, Eq.~\\eqref{eq:one}, \\ref{sec:a&b}, \\citep[see][p. 2]{smith2024,doe2025}, \\citet{smith2024}, and \\citeyear{doe2025}.',
                '\\label{sec:a&b}'
            ].join('\n'),
            '\\begin{equation}\\label{eq:one}x=1\\end{equation}'
        ]);
        doc.bibEntries = new Map([
            ['smith2024', { key: 'smith2024', type: 'article', fields: { author: 'Smith, Jane', year: '2024', title: 'A Paper' } }],
            ['doe2025', { key: 'doe2025', type: 'article', fields: { author: 'Doe, John', year: '2025', title: 'Another Paper' } }]
        ]);
        const renderer = new SmartRenderer();
        const payload = renderer.render(doc);
        const html = payload.htmls?.join('') ?? '';

        assert.match(html, /href="#sec:intro"[^>]*data-key="sec:intro"[^>]*>\?<\/a>/);
        assert.match(html, /href="#fig:missing"[^>]*data-key="fig:missing"[^>]*>\?<\/a>/);
        assert.match(html, /Eq\.&nbsp;\(<a href="#eq:one"[^>]*data-key="eq:one"[^>]*>\?<\/a>\)/);
        assert.match(html, /id="sec:a&amp;b"/);
        assert.match(html, /href="#sec:a&amp;b"[^>]*data-key="sec:a&amp;b"[^>]*>\?<\/a>/);
        assert.match(html, /\(see <a href="#ref-smith2024"[^>]*>Smith, 2024<\/a>; <a href="#ref-doe2025"[^>]*>Doe, 2025<\/a>, p\. 2\)/);
        assert.match(html, /Smith \(<a href="#ref-smith2024"[^>]*>2024<\/a>\)/);
        assert.match(html, /and <a href="#ref-doe2025"[^>]*>2025<\/a>/);
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

    test('escapes TikZ script terminators without dropping the original code', () => {
        const html = renderBlocks([
            [
                '\\begin{tikzpicture}',
                '\\node {</script><img src=x onerror=alert(1)>};',
                '\\end{tikzpicture}'
            ].join('\n')
        ]);

        assert.equal(html.match(/<\/script>/gi)?.length ?? 0, 1);
        assert.match(html, /<\\\/script><img src=x onerror=alert\(1\)>/);
    });

    test('injects only TikZ libraries used by each picture', () => {
        const renderer = new SmartRenderer();
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
        const renderer = new SmartRenderer();
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

    test('exposes TikZ preview lowerings through a named optimizer pipeline', () => {
        assert.deepStrictEqual(
            TIKZ_PREVIEW_LOWERINGS.map(lowering => ({
                name: lowering.name,
                affectedLibraries: lowering.affectedLibraries
            })),
            [{ name: 'simple-arrows-meta-tips', affectedLibraries: ['arrows.meta'] }]
        );

        const optimized = optimizeTikzPreviewSource({
            globalPreamble: '\\tikzset{arrow/.style={-Latex, thick}}',
            options: 'arrow/.style={Stealth-Stealth}',
            content: '\\draw[Latex-] (0,0) -- (1,0);',
            macroDefinitions: '\\def\\fastArrow{Latex-Latex}'
        });

        assert.deepStrictEqual(optimized.appliedLowerings, ['simple-arrows-meta-tips']);
        assert.equal(optimized.globalPreamble, '\\tikzset{arrow/.style={->, thick}}');
        assert.equal(optimized.options, 'arrow/.style={<->}');
        assert.equal(optimized.content, '\\draw[<-] (0,0) -- (1,0);');
        assert.equal(optimized.macroDefinitions, '\\def\\fastArrow{<->}');

        const exact = optimizeTikzPreviewSource({
            globalPreamble: '',
            options: '',
            content: '\\draw[-{Latex[length=3mm]}] (0,0) -- (1,0);',
            macroDefinitions: ''
        });
        assert.deepStrictEqual(exact.appliedLowerings, []);
        assert.match(exact.content, /-\{Latex\[length=3mm\]\}/);
    });

    test('uses TikZ preview lowerings to avoid arrows.meta for simple preview arrows', () => {
        const renderer = new SmartRenderer();
        const doc = createDocument([
            [
                '\\begin{tikzpicture}[',
                '  node distance=1.7cm,',
                '  arrow/.style={-Latex, thick}',
                ']',
                '\\node (source) {source};',
                '\\node[right=of source] (blocks) {blocks};',
                '\\draw[arrow] (source) -- (blocks);',
                '\\end{tikzpicture}'
            ].join('\n')
        ], {
            tikzGlobal: '\\usetikzlibrary{arrows.meta, positioning}'
        });
        const html = renderer.render(doc).htmls?.join('') ?? '';

        assert.match(html, /\\usetikzlibrary\{positioning\}/);
        assert.match(html, /arrow\/\.style=\{->, thick\}/);
        assert.doesNotMatch(html, /arrows\.meta/);
        assert.doesNotMatch(html, /-Latex/);
    });

    test('keeps arrows.meta for exact parameterized TikZ arrow tips', () => {
        const renderer = new SmartRenderer();
        const doc = createDocument([
            [
                '\\begin{tikzpicture}',
                '\\draw[-{Latex[length=3mm]}] (0,0) -- (1,0);',
                '\\end{tikzpicture}'
            ].join('\n')
        ], {
            tikzGlobal: '\\usetikzlibrary{arrows.meta, positioning}'
        });
        const html = renderer.render(doc).htmls?.join('') ?? '';

        assert.match(html, /\\usetikzlibrary\{arrows\.meta\}/);
        assert.match(html, /-\{Latex\[length=3mm\]\}/);
        assert.doesNotMatch(html, /positioning/);
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
        const renderer = new SmartRenderer();
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
        const webviewSource = readWebviewRuntimeSource(repoRoot);

        assert.doesNotMatch(panelSource, /\bpdfData\b/);
        assert.doesNotMatch(panelSource, /\bbase64\b/i);
        assert.doesNotMatch(panelSource, /\btransport\b/);
        assert.doesNotMatch(webviewSource, /\bpdfData\b/);
        assert.doesNotMatch(webviewSource, /\bbase64\b/i);
        assert.doesNotMatch(webviewSource, /\btransport\b/);
    });

    test('requests viewport-near PDF canvases without waiting for observer scroll events', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = readWebviewRuntimeSource(repoRoot);

        assert.match(webviewSource, /isPdfCanvasNearViewport\(canvas\)/);
        assert.match(webviewSource, /this\.requestPdfCanvas\(canvas\);\s*return;/);
        assert.match(webviewSource, /schedulePendingPdfRender\(\)/);
    });

    test('uses non-streaming PDF.js URL loading for webview resource URIs', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = readWebviewRuntimeSource(repoRoot);

        assert.match(webviewSource, /disableRange:\s*true/);
        assert.match(webviewSource, /disableStream:\s*true/);
        assert.match(webviewSource, /disableAutoFetch:\s*true/);
    });

    test('creates a blob module worker for PDF.js inside the webview sandbox', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = readWebviewRuntimeSource(repoRoot);

        assert.match(webviewSource, /async function setupPdfWorker\(\)/);
        assert.match(webviewSource, /URL\.createObjectURL\(new Blob/);
        assert.match(webviewSource, /new Worker\(workerBlobUrl,\s*\{\s*type:\s*'module'\s*\}\)/);
        assert.match(webviewSource, /pdfjsLib\.GlobalWorkerOptions\.workerPort = worker/);
        assert.match(webviewSource, /await pdfRuntimeReady/);
    });

    test('sends full updates as block payloads without building a giant binary html buffer', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const panelSource = fs.readFileSync(path.join(repoRoot, 'src', 'panel.ts'), 'utf8');
        const webviewSource = readWebviewRuntimeSource(repoRoot);

        assert.match(panelSource, /if \(payload\.htmls\) \{\s*payload\.htmls = payload\.htmls\.map\(h => this\.fixHtmlPaths\(h\)\)/);
        assert.match(panelSource, /this\._renderer\.render\(this\._currentDocument, \{ deferFullHtml: virtualizeBlocks \}\)/);
        assert.match(panelSource, /WebviewToExtensionCommand\.RequestBlockHtml/);
        assert.match(panelSource, /ExtensionToWebviewCommand\.BlockHtml/);
        assert.match(panelSource, /this\._renderer\.renderBlockByIndex\(index\)/);
        assert.match(panelSource, /this\.postMessage\(\{ command: ExtensionToWebviewCommand\.Update, payload \}\)/);
        assert.doesNotMatch(panelSource, /Buffer\.from\(fullHtml\)/);
        assert.doesNotMatch(panelSource, /command: 'update_binary'/);
        assert.match(webviewSource, /smartFullUpdateFromBlocks\(htmls, preserveUnchangedBlocks = true\)/);
        assert.match(webviewSource, /smartFullUpdateFromBlockMetadata\(blocks, preserveUnchangedBlocks = true\)/);
        assert.match(webviewSource, /payload\.blocks && this\.virtualization\.isEnabled\(\)/);
        assert.match(webviewSource, /vscode\.postMessage\(\{ command: WebviewToExtensionCommand\.RequestBlockHtml, id, index, hash \}\)/);
        assert.match(webviewSource, /case ExtensionToWebviewCommand\.BlockHtml:/);
        assert.match(webviewSource, /parseBlockHtml\(html\)/);
        assert.match(webviewSource, /const shellHash = shell\.getAttribute\('data-block-hash'\) \|\| ''/);
        assert.match(webviewSource, /if \(hash && shellHash && shellHash !== hash\) return null/);
        assert.match(webviewSource, /callbacks: requestOptions\.onLoaded \? \[requestOptions\.onLoaded\] : \[\]/);
        assert.match(webviewSource, /pending\.callbacks\.push\(requestOptions\.onLoaded\)/);
        assert.match(webviewSource, /this\.smartFullUpdateFromBlocks\(payload\.htmls, payload\.preserveUnchangedBlocks !== false\)/);
    });

    test('resets renderer state when switching root documents', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const panelSource = fs.readFileSync(path.join(repoRoot, 'src', 'panel.ts'), 'utf8');

        assert.match(panelSource, /const previousSourceUri = this\._sourceUri/);
        assert.match(panelSource, /normalizeUri\(previousSourceUri\) !== normalizeUri\(docUri\)/);
        assert.match(panelSource, /if \(sourceChanged\) \{\s*this\._renderer\.resetState\(\);\s*\}/);
    });

    test('uses virtual mode by default while honoring explicit legacy settings', () => {
        const makeConfig = (
            values: Record<string, boolean | undefined>,
            explicit: Record<string, boolean | undefined> = values
        ) => ({
            get: (key: string, fallback: boolean) => values[key] ?? fallback,
            inspect: (key: string) => explicit[key] === undefined ? undefined : { globalValue: explicit[key] }
        }) as unknown as vscode.WorkspaceConfiguration;

        assert.equal(getVirtualMode(makeConfig({})), true);
        assert.equal(getVirtualMode(makeConfig({ virtualMode: false })), false);
        assert.equal(getVirtualMode(makeConfig(
            { experimentalVirtualization: false },
            { experimentalVirtualization: false }
        )), false);
        assert.equal(getVirtualMode(makeConfig(
            { virtualMode: true, experimentalVirtualization: false },
            { virtualMode: true, experimentalVirtualization: false }
        )), true);
    });

    test('waits for the webview ready handshake before sending the first preview update', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const panelSource = fs.readFileSync(path.join(repoRoot, 'src', 'panel.ts'), 'utf8');
        const extensionSource = fs.readFileSync(path.join(repoRoot, 'src', 'extension.ts'), 'utf8');

        assert.match(panelSource, /private _webviewReady = false/);
        assert.match(panelSource, /case WebviewToExtensionCommand\.WebviewLoaded:[\s\S]*this\._webviewReady = true/);
        assert.match(panelSource, /void this\.update\(this\._pendingRootUri\)/);
        assert.match(panelSource, /const docUri = rootUri \?\? this\._pendingRootUri \?\? this\.resolveUpdateUri\(\)/);
        assert.match(panelSource, /if \(!this\._webviewReady\) \{\s*return;\s*\}/);
        assert.match(extensionSource, /const panel = TexPreviewPanel\.createOrShow\(context\.extensionUri, renderer\)/);
        assert.match(extensionSource, /void panel\.update\(editor\.document\.uri\)/);
    });

    test('prunes virtualized block html and height caches to active block keys', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = readWebviewRuntimeSource(repoRoot);

        assert.match(webviewSource, /pruneCaches\(activeKeys\)/);
        assert.match(webviewSource, /prune\(this\.heightCache\)/);
        assert.match(webviewSource, /prune\(this\.htmlCache\)/);
        assert.match(webviewSource, /this\.virtualization\.pruneCachesFromContent\(\)/);
    });

    test('releases far-offscreen PDF canvas bitmaps while preserving layout for rerender', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = readWebviewRuntimeSource(repoRoot);

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
    test('loads webview runtime from bundled scripts instead of inline HTML', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const htmlSource = fs.readFileSync(path.join(repoRoot, 'media', 'webview.html'), 'utf8');
        const panelSource = fs.readFileSync(path.join(repoRoot, 'src', 'panel.ts'), 'utf8');
        const buildSource = fs.readFileSync(path.join(repoRoot, 'esbuild.js'), 'utf8');

        assert.match(htmlSource, /<script src="\{\{webviewMainUri\}\}"><\/script>/);
        assert.match(htmlSource, /<script src="\{\{webviewPdfUri\}\}"><\/script>/);
        assert.doesNotMatch(htmlSource, /class PreviewController/);
        assert.doesNotMatch(htmlSource, /class BlockVirtualizationController/);
        assert.match(panelSource, /const webviewMainUri = toUri\('media\/webview-main\.js'\)/);
        assert.match(panelSource, /const webviewPdfUri = toUri\('media\/webview-pdf\.js'\)/);
        assert.match(buildSource, /entryPoints: \['src\/webview\/main\.ts'\]/);
        assert.match(buildSource, /entryPoints: \['src\/webview\/pdf\.ts'\]/);
    });

    test('keeps the webview CSP on bundled resources instead of remote script/connect sources', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const htmlSource = fs.readFileSync(path.join(repoRoot, 'media', 'webview.html'), 'utf8');

        assert.doesNotMatch(htmlSource, /https:\/\/unpkg\.com/);
        assert.doesNotMatch(htmlSource, /script-src[^;]*https:/);
        assert.doesNotMatch(htmlSource, /connect-src[^;]*https:/);
    });

    test('keeps renderOnSwitch fallbacks aligned with the contributed default', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
        const extensionSource = fs.readFileSync(path.join(repoRoot, 'src', 'extension.ts'), 'utf8');

        assert.equal(packageJson.contributes.configuration.properties['snaptex.renderOnSwitch'].default, false);
        assert.doesNotMatch(extensionSource, /get<boolean>\('renderOnSwitch', true\)/);
        assert.match(extensionSource, /get<boolean>\('renderOnSwitch', false\)/);
    });

    test('lazy-loads TikZJax only when TikZ scripts are present', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = readWebviewRuntimeSource(repoRoot);

        assert.doesNotMatch(webviewSource, /<script src="\{\{tikzJaxJsUri\}\}" id="tikzjax-script" defer><\/script>/);
        assert.match(webviewSource, /data-tikz-jax-js-uri="\{\{tikzJaxJsUri\}\}"/);
        assert.match(webviewSource, /window\.tikzJaxJsUri = document\.body\.dataset\.tikzJaxJsUri \|\| ''/);
        assert.match(webviewSource, /window\.ensureTikzJaxLoaded = function\(\)/);
        assert.match(webviewSource, /script\.src = window\.tikzJaxJsUri/);
        assert.match(webviewSource, /TIKZ_PENDING_SCRIPT_TYPE = 'text\/snaptex-tikz'/);
        assert.match(webviewSource, /window\.activatePendingTikzScripts = function/);
        assert.match(webviewSource, /querySelector\(TIKZ_SCRIPT_SELECTOR\)/);
    });

    test('marks stuck TikZ renders as failed instead of leaving permanent loaders', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = readWebviewRuntimeSource(repoRoot);

        assert.match(webviewSource, /window\.failPendingTikzContainers = function\(message\)/);
        assert.match(webviewSource, /window\.watchPendingTikzContainers = function\(root = document\)/);
        assert.match(webviewSource, /TikZ rendering timed out/);
        assert.match(webviewSource, /svg\[role="img"\]/);
    });

    test('does not timeout TikZ containers while they are only waiting in the TikZJax queue', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = readWebviewRuntimeSource(repoRoot);

        assert.match(webviewSource, /document\.addEventListener\('tikzjax-tex-input'/);
        assert.match(webviewSource, /document\.addEventListener\('tikzjax-load-finished'/);
        assert.match(webviewSource, /window\.failTikzContainer = function\(container, message\)/);
        assert.match(webviewSource, /setTikzContainerState\(container, 'queued'\)/);
        assert.match(webviewSource, /setTikzContainerState\(container, 'rendering'\)/);
        assert.doesNotMatch(webviewSource, /setTimeout\(\(\) => \{[\s\S]*window\.failPendingTikzContainers\('TikZ rendering timed out\.'\)/);
    });

    test('coalesces TikZ activation so edits during a render only queue the latest run', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = readWebviewRuntimeSource(repoRoot);
        const schedulerSource = fs.readFileSync(path.join(repoRoot, 'src', 'webview', 'scheduler.ts'), 'utf8');

        assert.match(webviewSource, /const TIKZ_RENDER_DEBOUNCE_MS = 200/);
        assert.match(webviewSource, /class CoalescingTaskScheduler/);
        assert.match(schedulerSource, /interface CoalescingTaskSchedulerOptions/);
        assert.doesNotMatch(schedulerSource, /@ts-nocheck/);
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
        const webviewSource = readWebviewRuntimeSource(repoRoot);
        const styleSource = fs.readFileSync(path.join(repoRoot, 'media', 'preview-style.css'), 'utf8');

        assert.match(webviewSource, /collectTikzPreviews\(block\)/);
        assert.match(webviewSource, /attachStaleTikzPreviews\(block, previews\)/);
        assert.match(webviewSource, /stashStaleTikzPreviewsOnShell\(shell, previews\)/);
        assert.match(webviewSource, /consumeStaleTikzPreviewsFromShell\(shell\)/);
        assert.match(webviewSource, /replaceBlockPreservingTikz\(oldBlock, newBlock\)/);
        assert.match(webviewSource, /applyStaleTikzPreviewsToBlock\(newBlock, oldBlock\)/);
        assert.match(webviewSource, /const staleTikzByIndex = new Map\(\)/);
        assert.match(webviewSource, /this\.stashStaleTikzPreviewsOnShell\(shell, staleTikzByIndex\.get\(index\)\)/);
        assert.match(webviewSource, /this\.attachStaleTikzPreviews\(block, this\.consumeStaleTikzPreviewsFromShell\(shell\)\)/);
        assert.match(webviewSource, /preview\.classList\.add\('tikz-stale-preview'\)/);
        assert.match(webviewSource, /container\.querySelectorAll\('\.tikz-stale-preview'\)\.forEach\(preview => preview\.remove\(\)\)/);
        assert.match(webviewSource, /svg\[role="img"\]:not\(\.tikz-stale-preview\)/);
        assert.match(styleSource, /\.tikz-container\[data-tikz-state="queued"\] > svg:not\(\.tikz-stale-preview\)/);
        assert.match(styleSource, /\.tikz-stale-preview/);
    });

    test('uses block hashes instead of outerHTML to preserve unchanged full-update blocks', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const rendererSource = fs.readFileSync(path.join(repoRoot, 'src', 'renderer.ts'), 'utf8');
        const webviewSource = readWebviewRuntimeSource(repoRoot);

        assert.match(rendererSource, /data-block-hash="\$\{stableHash\(text\)\}"/);
        assert.match(rendererSource, /preserveUnchangedBlocks:\s*!macrosChanged/);
        assert.match(webviewSource, /shouldReplaceBlock\(oldBlock, newBlock, preserveUnchangedBlocks\)/);
        assert.match(webviewSource, /oldBlock\.getAttribute\('data-block-hash'\)/);
        assert.match(webviewSource, /newBlock\.getAttribute\('data-block-hash'\)/);
        assert.match(webviewSource, /this\.smartFullUpdate\(payload\.html, payload\.preserveUnchangedBlocks !== false\)/);
        assert.doesNotMatch(webviewSource, /outerHTML !==/);
    });

    test('keeps shell virtualization enabled behind virtual mode by default', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const packageSource = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
        const panelSource = fs.readFileSync(path.join(repoRoot, 'src', 'panel.ts'), 'utf8');
        const webviewSource = readWebviewRuntimeSource(repoRoot);
        const styleSource = fs.readFileSync(path.join(repoRoot, 'media', 'preview-style.css'), 'utf8');

        assert.match(packageSource, /"snaptex\.virtualMode"/);
        assert.match(packageSource, /"default": true/);
        assert.doesNotMatch(packageSource, /"snaptex\.experimentalVirtualization"/);
        assert.match(panelSource, /virtualMode: getVirtualMode\(config\)/);
        assert.match(panelSource, /const virtualizeBlocks = getVirtualMode\(\)/);
        assert.match(panelSource, /config\.inspect<boolean>\('experimentalVirtualization'\)/);
        assert.match(webviewSource, /class BlockVirtualizationController/);
        assert.match(webviewSource, /this\.enabled = false/);
        assert.match(webviewSource, /this\.heightCache = new Map\(\)/);
        assert.match(webviewSource, /this\.htmlCache = new Map\(\)/);
        assert.match(webviewSource, /rememberBlockHeight\(block\)/);
        assert.match(webviewSource, /createShellForBlock\(block\)/);
        assert.match(webviewSource, /createShellForMeta\(meta\)/);
        assert.match(webviewSource, /getAnchorIdsFromBlock\(block\)/);
        assert.match(webviewSource, /findShellByAnchorId\(anchorId\)/);
        assert.match(webviewSource, /data-html-loaded/);
        assert.match(webviewSource, /data-html-requested/);
        assert.match(webviewSource, /className = 'latex-block-shell'/);
        assert.match(webviewSource, /data-mounted/);
        assert.match(webviewSource, /BLOCK_VIRTUALIZATION_BASE_PRELOAD_MARGIN/);
        assert.match(webviewSource, /BLOCK_VIRTUALIZATION_DIRECTIONAL_PRELOAD_MARGIN/);
        assert.match(webviewSource, /BLOCK_VIRTUALIZATION_RETAIN_MARGIN/);
        assert.match(webviewSource, /BLOCK_VIRTUALIZATION_CLEANUP_DELAY_MS/);
        assert.match(webviewSource, /mountShell\(shell, onMissingHtml\)/);
        assert.match(webviewSource, /unmountShell\(shell\)/);
        assert.match(webviewSource, /lockShellHeight\(shell, height\)/);
        assert.match(webviewSource, /unlockShellHeight\(shell\)/);
        assert.match(webviewSource, /refreshMountedShellHeight\(shell\)/);
        assert.match(webviewSource, /isShellAboveViewport\(shell\)/);
        assert.match(webviewSource, /if \(this\.isShellAboveViewport\(shell\)\) \{\s*this\.lockShellHeight\(shell, reservedHeight\);\s*\} else \{\s*this\.unlockShellHeight\(shell\);\s*\}/);
        assert.match(webviewSource, /if \(this\.isShellAboveViewport\(shell\)\) \{\s*this\.lockShellHeight\(shell, height\);\s*\} else \{\s*this\.unlockShellHeight\(shell\);\s*\}/);
        assert.doesNotMatch(webviewSource, /forceHeightUpdate/);
        assert.match(webviewSource, /shell\.style\.height = ''/);
        assert.match(webviewSource, /shell\.style\.minHeight = ''/);
        assert.match(styleSource, /\.latex-block-shell\s*\{[\s\S]*overflow: hidden;/);
        assert.match(styleSource, /\.latex-block-shell\s*>\s*\.latex-block\s*\{[\s\S]*content-visibility: visible;/);
        assert.match(styleSource, /\.latex-block-shell\s*>\s*\.latex-block\s*\{[\s\S]*contain-intrinsic-size: unset;/);
        assert.match(webviewSource, /updateMountedShells\(onMount, onMissingHtml, options = \{\}\)/);
        assert.match(webviewSource, /isShellInMountRange\(shell, direction = 'none'\)/);
        assert.match(webviewSource, /isShellInRetainRange\(shell\)/);
        assert.doesNotMatch(webviewSource, /window\.scrollBy\(0, delta\)/);
        assert.doesNotMatch(webviewSource, /withScrollCompensation\(shell, action\)/);
        assert.match(webviewSource, /this\.resizeObserver = typeof ResizeObserver !== 'undefined'/);
        assert.match(webviewSource, /onShellResize\(entries\)/);
        assert.match(webviewSource, /this\.virtualization\.unobserveShell\(shell\)/);
        assert.match(webviewSource, /replaceContentWithShells\(blocks, onMount\)/);
        assert.match(webviewSource, /replaceContentWithBlockMetadata\(blocks, onMount, onMissingHtml\)/);
        assert.match(webviewSource, /storeBlockHtml\(index, hash, html\)/);
        assert.match(webviewSource, /this\.config\.virtualMode = event\.data\.config\.virtualMode !== false/);
        assert.match(webviewSource, /this\.virtualization\.setEnabled\(event\.data\.config\.virtualMode !== false\)/);
        assert.match(webviewSource, /this\.virtualization\.replaceContentWithShells\(newElements/);
        assert.match(webviewSource, /applyVirtualPatch\(payload\)/);
        assert.match(webviewSource, /getBlockByIndex\(index\)/);
        assert.match(webviewSource, /this\.getBlockByIndex\(idx\)/);
        assert.match(webviewSource, /getBlockOrShellByIndex\(index\)/);
        assert.match(webviewSource, /window\.addEventListener\('resize', \(\) => this\.updateVirtualizedBlocks\(\{ allowUnmount: true \}\)\)/);
        assert.match(webviewSource, /this\.virtualization\.rememberBlockHeight\(oldBlock\)/);
    });

    test('routes virtualized refs and tooltips through anchor-aware shell mounting', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = readWebviewRuntimeSource(repoRoot);

        assert.match(webviewSource, /window\.snaptexPreviewController = this/);
        assert.match(webviewSource, /document\.addEventListener\('click', event => this\.onInternalLinkClick\(event\)\)/);
        assert.match(webviewSource, /async ensureAnchorMounted\(anchorId\)/);
        assert.match(webviewSource, /this\.virtualization\.findShellByAnchorId\(anchorId\)/);
        assert.match(webviewSource, /await this\.ensureShellMounted\(shell\)/);
        assert.match(webviewSource, /async onInternalLinkClick\(event\)/);
        assert.match(webviewSource, /event\.preventDefault\(\)/);
        assert.match(webviewSource, /await this\.ensureAnchorMounted\(anchorId\)/);
        assert.match(webviewSource, /async resolveTargetElement\(targetId\)/);
        assert.match(webviewSource, /controller\.ensureAnchorMounted\(targetId\)/);
        assert.match(webviewSource, /async resolveContextBlocks\(container\)/);
        assert.match(webviewSource, /controller\.getTooltipContextBlocks\(container\)/);
        assert.match(webviewSource, /async getTooltipContextBlocks\(block\)/);
        assert.match(webviewSource, /Promise\.all\(indices\.map\(index => this\.ensureBlockMountedByIndex\(index\)\)\)/);
        assert.match(webviewSource, /return this\.contentRoot\.querySelector\('\.latex-block\[data-index="' \+ index \+ '"\]'\)/);
    });

    test('stabilizes virtualized forward sync before scrolling', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const extensionSource = fs.readFileSync(path.join(repoRoot, 'src', 'extension.ts'), 'utf8');
        const webviewSource = readWebviewRuntimeSource(repoRoot);

        assert.match(extensionSource, /let autoSyncTimer: NodeJS\.Timeout \| undefined/);
        assert.match(extensionSource, /const clearPendingAutoSync = \(\) =>/);
        assert.match(extensionSource, /const scheduleAutoSyncToPreview = \(/);
        assert.match(extensionSource, /clearPendingAutoSync\(\);\s*if \(editor\) \{ triggerSyncToPreview/);
        assert.match(webviewSource, /this\.scrollCommandSeq = 0/);
        assert.match(webviewSource, /async ensureBlockMountedByIndex\(index\)/);
        assert.match(webviewSource, /if \(target\) return \{ target, mounted: false \}/);
        assert.match(webviewSource, /const block = await this\.ensureShellMounted\(shell\)/);
        assert.match(webviewSource, /return \{ target: block \|\| shell, mounted: Boolean\(block\) \}/);
        assert.match(webviewSource, /async executeScroll\(data\)/);
        assert.match(webviewSource, /const scrollSeq = \+\+this\.scrollCommandSeq/);
        assert.match(webviewSource, /const mountResult = await this\.ensureBlockMountedByIndex\(index\)/);
        assert.match(webviewSource, /if \(!auto \|\| mountResult\.mounted\) \{\s*await this\.waitForLayout\(\)/);
        assert.match(webviewSource, /const autoSkipThreshold = 12/);
        assert.match(webviewSource, /this\.requestVirtualizedUpdate\(\{ allowUnmount: false \}\)/);
        assert.match(webviewSource, /this\.scheduleVirtualizedCleanup\(\)/);
        assert.match(webviewSource, /this\.scrollDirection = delta < 0 \? 'up' : 'down'/);
        assert.match(webviewSource, /direction: this\.scrollDirection/);
        assert.match(webviewSource, /allowUnmount: options\.allowUnmount !== false/);
        assert.doesNotMatch(webviewSource, /setTimeout\(\(\) => \{[\s\S]*const newTargetY = calcY\(\)/);
    });

    test('routes TikZ compile failures through the webview error state', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const webviewSource = readWebviewRuntimeSource(repoRoot);
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
        assert.match(buildSource, /function applyTextPatches/);
        assert.match(buildSource, /function createTikzJaxSourcePatches/);
        assert.match(buildSource, /function createRunTexSourcePatches/);
        assert.match(buildSource, /function patchTextFile/);
        assert.match(buildSource, /const tikzJaxPatched = patchTextFile\(tikzJaxFile, createTikzJaxSourcePatches\(runtimeAssetFiles\)\)/);
        assert.match(buildSource, /const runTexPatched = patchTextFile\(runTexFile, createRunTexSourcePatches\(\)\)/);
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

