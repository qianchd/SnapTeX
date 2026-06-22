/// <reference types="mocha" />

import * as assert from 'assert';
import * as vscode from 'vscode';
import { LatexDocument } from '../document';
import { getVirtualMode, isUriWithinAllowedRoots, normalizePdfRequestPath } from '../panel';
import { SmartRenderer } from '../renderer';
import { defineBlockDependencyRule, defineRuleRegistry, SNAP_TEX_RULES } from '../rules';
import type { RuleRegistry } from '../types';
import { normalizeUri, stableHash, stripLatexComments } from '../utils';
import {
    createDocument,
    MemoryFileProvider,
    readFixture,
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
        assert.equal(doc.getBlockCount(), 2);
        assert.equal(doc.getBlockText(1)?.trim(), 'Second paragraph with \\label{p:two}.');
        assert.equal(doc.getBlockText(2), undefined);
        assert.equal(doc.getBlockHash(0), result.blockHashes[0]);

        const renderer = new SmartRenderer();
        renderer.render(doc);
        const sourceSync = renderer.getSourceSyncData(1, 0.5);
        assert.ok(sourceSync?.blockRange);
        assert.ok(sourceSync.blockRange.startLine <= sourceSync.line && sourceSync.blockRange.endLine >= sourceSync.line);

        doc.releaseTextContent();
        assert.equal(doc.getBlockCount(), 0);
        assert.equal(doc.getBlockText(0), undefined);
        assert.equal(doc.getBlockHash(0), undefined);
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
        assert.ok(blocks.every(block => stripLatexComments(block, { preserveLines: true }).trim().length > 0));
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

    test('renders tabular star tables with nested tabular cells', () => {
        const html = renderBlocks([
            [
                '\\begin{table}[!ht]',
                '\\setlength\\tabcolsep{0pt}',
                '\\begin{threeparttable}',
                '\\caption{Terms contributing to the bias for a given homogeneous segment $I$.}',
                '\\label{tab:bias}',
                '\\centering',
                '\\begin{tabular*}{\\textwidth}{c@{\\extracolsep{\\fill}}*{4}{c}}',
                '\\toprule',
                'Loss & Model & $\\mathsf{Cross}$ & $\\mathsf{Squared}$ \\\\',
                '\\midrule',
                'In-sample & $\\hf_I^\\mathsf{lasso}(\\lambda^\\circ)$ & $\\mathcal{O}_p(s_n\\log p)$ & $\\mathcal{O}_p(s_n\\log p)$ \\\\',
                '\\\\',
                'In-sample & $\\hf_I^\\mathsf{lasso}(\\hlam_I^{\\cv})$ & \\begin{tabular}{@{}>{$}l<{$}}',
                '\\mathcal{O}_p(\\|u_I^\\top X_I\\|_\\infty \\cdot \\sqrt{s_n})\\\\',
                '~~~~~~=\\mathcal{O}_p(\\sqrt{\\size{I}\\log p})\\\\',
                '~~~~~~=\\mathcal{O}_p(s_n\\log^{3/2}p)',
                '\\end{tabular} & $\\mathcal{O}_p(s_n\\log^2 p)$ \\\\',
                '\\\\',
                'Out-of-sample & $\\hf_{J_{-m, I}}^\\mathsf{lasso}(\\hlam_{J_{-m, I}}^{\\cv})$ & $\\mathcal{O}_p(\\sqrt{s_n\\log^2 p})$ & $\\mathcal{O}_p(s_n\\log^2 p)$ \\\\',
                '\\bottomrule',
                '\\end{tabular*}',
                '\\end{threeparttable}',
                '\\end{table}'
            ].join('\n')
        ]);

        assert.match(html, /id="tab:bias"/);
        assert.match(html, /<table class="latex-tabular-preview latex-tabular-booktabs">/);
        assert.match(html, /class="latex-nested-tabular latex-nested-tabular-math"/);
        assert.match(html, /Out-of-sample/);
        const tbodyHtml = /<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? '';
        assert.equal(tbodyHtml.match(/<tr/g)?.length, 3);
        assert.doesNotMatch(html, /\\begin\{threeparttable\}|\\begin\{tabular\*\}|\\setlength\\tabcolsep/);
        assert.doesNotMatch(html, /<tr><td>\s*<\/td><\/tr>/);
        assert.doesNotMatch(html, /XSNAP/);
    });

    test('renders multicolumn and multirow table cells', () => {
        const html = renderBlocks([
            [
                '\\begin{table}',
                '\\caption{Grouped table}',
                '\\begin{tabular}{lll}',
                '\\toprule',
                '\\multicolumn{2}{c}{\\textbf{Group}} & \\textbf{Total} \\\\',
                '\\midrule',
                '\\multirow{2}{*}{A} & x & 1 \\\\',
                ' & y & 2 \\\\',
                'Hausdorff distance & \\multicolumn{2}{c}{\\{22, 9\\}} \\\\',
                '\\bottomrule',
                '\\end{tabular}',
                '\\end{table}'
            ].join('\n')
        ]);

        assert.match(html, /<th scope="col" colspan="2" class="table-cell-align-center"><strong>Group<\/strong><\/th>/);
        assert.match(html, /<td rowspan="2">A<\/td><td>x<\/td><td>1<\/td>/);
        assert.match(html, /<td>Hausdorff distance<\/td><td colspan="2" class="table-cell-align-center">\{22, 9\}<\/td>/);
        assert.doesNotMatch(html, /\\multicolumn|\\multirow/);
    });

    test('renders makecell line breaks and table note markers', () => {
        const html = renderBlocks([
            [
                '\\begin{table}[!ht]',
                '\\begin{threeparttable}',
                '\\caption{Model table}',
                '\\begin{tabular*}{\\textwidth}{ccc}',
                '\\toprule',
                'Model & Loss & Estimator \\\\',
                '\\midrule',
                '\\makecell{$f_i^\\ast=(\\mu_i,\\Omega_i)$,\\\\ $P_i=\\mathcal{N}(\\mu_i,\\Omega_i^{-1})$} & $\\sum_{i\\in I}(y_i-x_i)^2$ & $\\hat f_I$\\tnote{$\\mathparagraph$} \\\\',
                '\\bottomrule',
                '\\end{tabular*}',
                '\\begin{tablenotes}[flushleft]\\footnotesize',
                '\\item[$\\mathparagraph$] The superscript marks a regularized estimator with $\\alpha\\in(0,1)$.',
                '\\end{tablenotes}',
                '\\end{threeparttable}',
                '\\end{table}'
            ].join('\n')
        ]);

        assert.match(html, /<span class="latex-makecell">/);
        assert.equal(html.match(/latex-makecell-line/g)?.length, 2);
        assert.match(html, /<sup class="latex-tnote">/);
        assert.match(html, /<div class="latex-tablenotes"><ul><li class="note-item"/);
        assert.match(html, /regularized estimator/);
        assert.doesNotMatch(html, /\\makecell|\\tnote|XSNAP/);
    });

    test('renders journal-style Abstract and Keywords commands', () => {
        const html = renderBlocks([
            [
                '\\Abstract{This paper studies robust sparse CCA for heavy-tailed data.}',
                '',
                '\\Keywords{Canonical correlation analysis, Elliptical distributions, High dimensional data}'
            ].join('\n')
        ]);

        assert.match(html, /<div class="latex-abstract"><span class="latex-abstract-title">Abstract<\/span>/);
        assert.match(html, /robust sparse CCA/);
        assert.match(html, /<div class="latex-keywords"><strong>Keywords:<\/strong> Canonical correlation analysis, Elliptical distributions, High dimensional data<\/div>/);
        assert.doesNotMatch(html, /\\Abstract|\\Keywords|OOABSTRACT|OOKEYWORDS/);
    });

    test('preserves paragraph boundaries inside block and inline color groups', () => {
        const blockHtml = renderBlocks([
            [
                '{\\color{blue}',
                '\\section{Styled Section}\\label{sec:styled}',
                'First synthetic paragraph.',
                '',
                '\\begin{proof}',
                'Proof body.',
                '\\end{proof}',
                '',
                '\\begin{itemize}',
                '\\item[Key] Labeled item.',
                '\\item Plain item.',
                '\\end{itemize}',
                '',
                '\\begin{theorem}Theorem body.\\end{theorem}',
                '',
                '\\begin{table}',
                '\\begin{tabular}{c}',
                'Cell \\\\',
                '\\end{tabular}',
                '\\end{table}',
                '',
                'Second synthetic paragraph.',
                '}'
            ].join('\n')
        ]);

        assert.doesNotMatch(blockHtml, /class="latex-block"[^>]*style="color: blue;"/);
        assert.match(blockHtml, /<div class="latex-style-scope" style="color: blue">[\s\S]*<h2>/);
        assert.match(blockHtml, /Styled Section/);
        assert.match(blockHtml, /<p>[\s\S]*First synthetic paragraph\.<\/p>/);
        assert.match(blockHtml, /<p>Second synthetic paragraph\.<\/p>/);
        assert.match(blockHtml, /<span class="no-indent-marker"><\/span><strong>Proof\.<\/strong>[\s\S]*Proof body\.[\s\S]*QED/);
        assert.match(blockHtml, /<li>\s*<p><strong>Key<\/strong>\s+Labeled item\.<\/p>\s*<\/li>/);
        assert.match(blockHtml, /<li>\s*<p>Plain item\.<\/p>\s*<\/li>/);
        assert.match(blockHtml, /class="latex-theorem"[\s\S]*Theorem body/);
        assert.match(blockHtml, /class="latex-table"[\s\S]*Cell/);
        assert.doesNotMatch(blockHtml, /\\color\{blue\}/);
        assert.doesNotMatch(blockHtml, /## Styled Section/);
        assert.doesNotMatch(blockHtml, /\*\*Proof\.\*\*/);
        assert.doesNotMatch(blockHtml, /\*\*Key\*\*/);

        const inlineHtml = renderBlocks([
            [
                'Lead sentence before color. {\\color{blue}Inline continuation with \\citep{alpha2026}.',
                '',
                'Second colored paragraph.',
                '}'
            ].join('\n')
        ]);

        assert.match(inlineHtml, /<p>Lead sentence before color\. <span style="color: blue">Inline continuation with \(\[alpha2026\?\]\)\.<\/span><\/p>/);
        assert.match(inlineHtml, /<\/p>\s*<p><span style="color: blue">Second colored paragraph\.<\/span><\/p>/);
        assert.doesNotMatch(inlineHtml, /\\color\{blue\}/);
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
        assert.match(payload.dirtyBlocks?.[2] ?? '', /ref-doe2025|doe2025/);
        assert.doesNotMatch(payload.dirtyBlocks?.[2] ?? '', /smith2024/);
    });

    test('does not refresh bibliography when citation key order changes without set changes', () => {
        const renderer = new SmartRenderer();
        renderer.render(createDocument([
            'See \\cite{smith2024,doe2025}.',
            '\\bibliography{refs}'
        ]));

        const payload = renderer.render(createDocument([
            'See \\cite{doe2025,smith2024}.',
            '\\bibliography{refs}'
        ]));

        assert.equal(payload.type, 'patch');
        assert.equal(payload.start, 0);
        assert.equal(payload.deleteCount, 1);
        assert.equal(payload.htmls?.length, 1);
        assert.equal(payload.dirtyBlocks?.[1], undefined);
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
        const block = renderer.renderBlockByIndex(1);
        assert.match(block?.html ?? '', /data-index="1"/);
        assert.equal(block?.hash, stableHash('\\begin{figure}\\caption{A}\\label{fig:a}\\end{figure}'));
        assert.match(block?.html ?? '', new RegExp(`data-block-hash="${stableHash('\\begin{figure}\\caption{A}\\label{fig:a}\\end{figure}')}"`));
    });

    test('escapes maketitle metadata while preserving LaTeX formatting', () => {
        const renderer = new SmartRenderer();
        const payload = renderer.render(createDocument(['\\maketitle'], {
            title: '<img src=x onerror=alert(1)> \\textbf{Safe} $x<y$\\footnote{Hidden note}',
            authors: [{ name: 'Ada & Bob', emails: [], affiliationIds: [] }],
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
        assert.doesNotMatch(html, /Hidden note/);
    });

    test('renders structured maketitle emails next to their authors', () => {
        const renderer = new SmartRenderer();
        const payload = renderer.render(createDocument(['\\maketitle'], {
            title: 'Shared Institute',
            authors: [
                { name: 'Alice Smith', emails: [], affiliationIds: ['inst1'] },
                { name: 'Bob Jones', emails: ['bob@b.edu'], affiliationIds: ['inst2'] },
                { name: 'Carol Lee', emails: ['carol@c.edu'], affiliationIds: ['inst1', 'inst3'] }
            ],
            affiliations: [
                { id: 'inst1', text: 'University A' },
                { id: 'inst2', text: 'University B' },
                { id: 'inst3', text: 'Institute C' }
            ],
            custom: { editor: 'Prof. Smith' }
        }));
        const html = payload.htmls?.join('') ?? '';

        assert.match(html, /Alice Smith<sup>1<\/sup>/);
        assert.match(html, /Bob Jones<sup>2<\/sup><span class="latex-author-email">bob@b\.edu<\/span>/);
        assert.match(html, /Carol Lee<sup>1,3<\/sup><span class="latex-author-email">carol@c\.edu<\/span>/);
        assert.doesNotMatch(html, /class="latex-email">bob@b\.edu, carol@c\.edu/);
        assert.match(html, /<sup>1<\/sup> University A/);
        assert.match(html, /class="latex-editor"><strong>Editor:<\/strong> Prof\. Smith/);
    });

    test('escapes raw source HTML while preserving generated preview HTML', () => {
        const html = renderBlocks([
            'Plain <img src=x onerror=alert(1)> and \\textbf{bold <script>alert(2)</script>}.',
            '\\begin{theorem}<script>alert(1)</script> and \\emph{safe}.\\end{theorem}'
        ]);

        assert.doesNotMatch(html, /<img|<script/i);
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
        assert.match(html, /<strong>bold &lt;script&gt;alert\(2\)&lt;\/script&gt;<\/strong>/);
        assert.match(html, /class="latex-theorem"/);
        assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.match(html, /<em>safe<\/em>/);
    });

    test('uses shared theorem display names for supported aliases', () => {
        const html = renderBlocks([
            '\\begin{assum}Bounded moments.\\end{assum}'
        ]);

        assert.match(html, /<strong class="latex-theorem-header">Assumption <span class="sn-cnt" data-type="thm"><\/span>/);
        assert.doesNotMatch(html, /Assum <span class="sn-cnt"/);
    });

    test('does not trust KaTeX HTML-producing commands by default', () => {
        const html = renderBlocks(['$\\href{javascript:alert(1)}{bad}$']);

        assert.doesNotMatch(html, /href="javascript:alert/i);
    });

    test('renders safe LaTeX links and escapes unsafe targets', () => {
        const safeHtml = renderBlocks([
            'See \\href{https://example.com/path?q=1&lang=en}{SnapTeX \\textbf{site}} and \\url{https://snaptex.dev/docs?a=1&b=2}.'
        ]);

        assert.match(safeHtml, /<a href="https:\/\/example\.com\/path\?q=1&amp;lang=en" class="latex-link latex-href" target="_blank" rel="noopener noreferrer">SnapTeX <strong>site<\/strong><\/a>/);
        assert.match(safeHtml, /<a href="https:\/\/snaptex\.dev\/docs\?a=1&amp;b=2" class="latex-link latex-url" target="_blank" rel="noopener noreferrer">https:\/\/snaptex\.dev\/docs\?a=1&amp;b=2<\/a>/);
        assert.doesNotMatch(safeHtml, /\\href|\\url/);

        const unsafeHtml = renderBlocks([
            '\\href{javascript:alert(1)}{bad <script>alert(1)</script>} \\url{javascript:alert(2)}'
        ]);

        assert.doesNotMatch(unsafeHtml, /href="javascript:alert/i);
        assert.doesNotMatch(unsafeHtml, /\\href|\\url/);
        assert.match(unsafeHtml, /bad &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.match(unsafeHtml, /javascript:alert\(2\)/);
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
        const html = payload.dirtyBlocks?.[0] ?? '';

        assert.equal(payload.type, 'patch');
        assert.equal(payload.start, 1);
        assert.equal(payload.htmls?.length, 0);
        assert.match(html, /Second &lt;tag&gt;/);
        assert.doesNotMatch(html, /Second <tag>/);
        assert.doesNotMatch(html, /data-block-hash="[^"]*Second/);
    });

    test('supports custom metadata-dependent blocks without recollecting unchanged dependencies', () => {
        let collectCount = 0;
        const registry: RuleRegistry = defineRuleRegistry({
            ...SNAP_TEX_RULES,
            blockDependencyRules: [
                ...SNAP_TEX_RULES.blockDependencyRules,
                defineBlockDependencyRule({
                    name: 'makecover',
                    collect: ({ text, deps }) => {
                        collectCount++;
                        if (!text.includes('\\makecover')) { return []; }
                        return [
                            deps.metadata('title'),
                            deps.metadata('custom.editor')
                        ];
                    }
                })
            ],
            renderRules: [
                ...SNAP_TEX_RULES.renderRules,
                {
                    name: 'makecover',
                    priority: 161,
                    apply: (text, renderer) => {
                        const metadata = renderer.metadata;
                        return text.replace(/\\makecover/g, () => renderer.protectHtml(
                            'meta',
                            `<div class="cover">${metadata?.title ?? ''} - ${metadata?.custom.editor ?? ''}</div>`
                        ));
                    }
                }
            ]
        });
        const renderer = new SmartRenderer(registry);

        renderer.render(createDocument(['\\makecover', 'Plain'], { title: 'A', custom: { editor: 'Old' } }));
        assert.equal(collectCount, 2);

        const payload = renderer.render(createDocument(['\\makecover', 'Plain'], { title: 'A', custom: { editor: 'New' } }));

        assert.equal(collectCount, 2);
        assert.equal(payload.type, 'patch');
        assert.equal(payload.htmls?.length, 0);
        assert.match(payload.dirtyBlocks?.[0] ?? '', /A - New/);
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

    test('hides bibliography style control commands', () => {
        const html = renderBlocks([
            [
                'Text before references.',
                '\\bibliographystyle{alpha}',
                '\\bibliography{sample}'
            ].join('\n')
        ]);

        assert.match(html, /Text before references\./);
        assert.doesNotMatch(html, /\\bibliographystyle|alpha/);
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
    test('normalizes safe pdf paths and rejects unsafe requests', () => {
        assert.equal(normalizePdfRequestPath('figure.pdf'), 'figure.pdf');
        assert.equal(normalizePdfRequestPath('./figures/Plot.PDF'), 'figures/Plot.PDF');
        assert.equal(normalizePdfRequestPath('figures\\plot.pdf'), 'figures/plot.pdf');

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

});

