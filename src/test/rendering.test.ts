/// <reference types="mocha" />

import * as assert from 'assert';
import { BrowserUri } from '../../apps/standalone/src/browser-file-provider';
import { LatexDocument } from '../document';
import { resolveProjectResourcePath } from '../file-provider';
import { SmartRenderer } from '../renderer';
import { defineAstMathRule, defineAstRenderRule, defineBlockDependencyRule, defineRuleRegistry, readAstCommandArguments, SNAP_TEX_RULES } from '../rules';
import type { RuleRegistry } from '../rules';
import { isMacroNode } from '../ast/visit-utils';
import { extractAstBlockArtifact } from '../ast/block-metadata';
import { normalizeUri, stripLatexComments } from '../utils';
import {
    createDocument,
    MemoryFileProvider,
    readFixture,
    renderBlocks,
    resultBlockTexts
} from './test-helpers';

suite('LatexDocument source mapping', () => {
    test('collects citation metadata through spaced optional arguments', async () => {
        const artifact = await extractAstBlockArtifact([
            'Text \\citep [see] {alpha,beta}.',
            '\\cite % detached comment',
            '{gamma}.'
        ].join('\n'), 'citation-test');
        assert.deepEqual(artifact.metadata.citations, ['alpha', 'beta', 'gamma']);
    });

    test('maps nested included source files back to their original lines', async () => {
        const mainUri = new BrowserUri('/project/main.tex');
        const sectionUri = new BrowserUri('/project/sections/section1.tex');
        const nestedUri = new BrowserUri('/project/sections/nested/detail.tex');
        const provider = new MemoryFileProvider(new Map([
            [normalizeUri(mainUri), [
                '\\documentclass{article}',
                '\\begin{document}',
                'Root before.',
                '\\input{sections/section1}',
                'Root after.',
                '\\end{document}'
            ].join('\n')],
            [normalizeUri(sectionUri), [
                'Section before.',
                '\\input{nested/detail}',
                'Section after.'
            ].join('\n')],
            [normalizeUri(nestedUri), [
                'Nested first line.',
                '',
                'Nested target line.'
            ].join('\n')]
        ]));
        const doc = new LatexDocument(provider);

        const result = await doc.parse(mainUri);
        doc.applyResult(result);

        assert.deepStrictEqual(resultBlockTexts(result).map(block => block.trim()), [
            'Root before.\nSection before.\nNested first line.',
            'Nested target line.\nSection after.\nRoot after.'
        ]);

        const sectionLine = doc.getFlattenedLine(sectionUri.toString(), 0);
        assert.notEqual(sectionLine, -1);
        const sectionOriginal = doc.getOriginalPosition(sectionLine);
        assert.ok(sectionOriginal);
        assert.equal(normalizeUri(sectionOriginal.file), normalizeUri(sectionUri));
        assert.equal(sectionOriginal.line, 0);

        const flatLine = doc.getFlattenedLine(nestedUri.toString(), 2);
        assert.notEqual(flatLine, -1);
        const original = doc.getOriginalPosition(flatLine);
        assert.ok(original);
        assert.equal(normalizeUri(original.file), normalizeUri(nestedUri));
        assert.equal(original.line, 2);
    });

    test('loads bibliography entries relative to the root document', async () => {
        const mainUri = new BrowserUri('/project/main.tex');
        const bibUri = new BrowserUri('/project/refs.bib');
        const extraBibUri = new BrowserUri('/project/more.bib');
        const provider = new MemoryFileProvider(new Map([
            [normalizeUri(mainUri), [
                '\\bibliography{refs,more}',
                '\\begin{document}',
                'See \\cite{smith2024,jones2025}.',
                '\\end{document}'
            ].join('\n')],
            [normalizeUri(bibUri), '@article{smith2024, title={Paper}, author={Smith, Jane}, year={2024}}'],
            [normalizeUri(extraBibUri), '@article{jones2025, title={More}, author={Jones, Alex}, year={2025}}']
        ]));
        const doc = new LatexDocument(provider);

        const result = await doc.parse(mainUri);

        assert.ok(result.bibEntries.has('smith2024'));
        assert.ok(result.bibEntries.has('jones2025'));
        assert.equal(result.bibEntries.get('smith2024')?.fields.title, 'Paper');
        assert.equal(result.contentStartLineOffset, 1);
        assert.equal(result.blockSpans.length, 1);
    });

    test('preserves explicit input file extensions', async () => {
        const mainUri = new BrowserUri('/project/main.tex');
        const bblUri = new BrowserUri('/project/references.bbl');
        const bibItems = Array.from({ length: 300 }, (_unused, index) =>
            `\\bibitem{entry${index}} Author ${index}. Paper ${index}.`
        );
        const provider = new MemoryFileProvider(new Map([
            [normalizeUri(mainUri), [
                '\\begin{document}',
                'See \\cite{entry0}.',
                '\\input{references.bbl}',
                '\\end{document}'
            ].join('\n')],
            [normalizeUri(bblUri), [
                '\\begin{thebibliography}{300}',
                ...bibItems,
                '\\end{thebibliography}'
            ].join('\n')]
        ]));

        const doc = new LatexDocument(provider);
        const result = await doc.parse(mainUri);
        doc.applyResult(result);
        const payload = await new SmartRenderer().renderAsync(doc);
        const html = payload.htmls?.join('\n') ?? '';

        assert.ok(result.bibEntries.has('entry0'));
        assert.doesNotMatch(result.diagnostics.map(item => item.message).join('\n'), /Missing input file/);
        assert.match(html, /class="latex-bibliography-list"/);
        assert.doesNotMatch(html, /\\(?:begin|end)\{thebibliography\}/);
    });

    test('uses preview anchors while preserving included-file source mapping', async () => {
        const mainUri = new BrowserUri('/project/main.tex');
        const sectionUri = new BrowserUri('/project/section.tex');
        const provider = new MemoryFileProvider(new Map([
            [normalizeUri(mainUri), [
                '\\begin{document}',
                '\\input{section}',
                '\\end{document}'
            ].join('\n')],
            [normalizeUri(sectionUri), [
                'same target near the start.',
                'middle one',
                'middle two',
                'same target near the end.'
            ].join('\n')]
        ]));
        const doc = new LatexDocument(provider);
        const result = await doc.parse(mainUri);
        doc.applyResult(result);

        const renderer = new SmartRenderer();
        await renderer.renderAsync(doc, { deferFullHtml: true });
        const sourceSync = renderer.getSourceSyncData(0, 0.9, { anchors: ['same target'] });

        assert.equal(sourceSync && normalizeUri(sourceSync.file), normalizeUri(sectionUri));
        assert.equal(sourceSync?.line, 3);
    });

    test('tracks bibliography dependencies and anchors from current AST citations only', async () => {
        const mainUri = new BrowserUri('/project/main.tex');
        const provider = new MemoryFileProvider(new Map([[normalizeUri(mainUri), '']]));
        const doc = new LatexDocument(provider);
        const renderer = new SmartRenderer();
        const makeSource = (fakeKey: string, citedKey = 'real', extraBlocks: readonly string[] = []) => [
            '\\begin{document}',
            `Real citation \\cite{${citedKey}}.`,
            `% Fake citation \\cite{${fakeKey}}.`,
            '',
            ...extraBlocks.flatMap(block => [block, '']),
            '\\bibliography{refs}',
            '\\end{document}'
        ].join('\n');

        let result = await doc.parse(mainUri, makeSource('old'), { backendMode: 'ast(experimental)' });
        doc.applyResult(result);
        await renderer.renderAsync(doc, { deferFullHtml: true });

        result = await doc.parse(mainUri, makeSource('new'), { backendMode: 'ast(experimental)' });
        doc.applyResult(result);
        const payload = await renderer.renderAsync(doc, { deferFullHtml: true });

        assert.equal(payload.type, 'patch');
        assert.equal(payload.dirtyBlocks?.[1], undefined);

        result = await doc.parse(mainUri, makeSource('new', 'current'), { backendMode: 'ast(experimental)' });
        doc.applyResult(result);
        const citationPatch = await renderer.renderAsync(doc, { deferFullHtml: true });
        assert.match(citationPatch.type === 'patch' ? citationPatch.dirtyBlocks?.[1] ?? '' : '', /id="ref-current"/);

        const extraBlocks = Array.from({ length: 51 }, (_unused, index) => `Inserted paragraph ${index}.`);
        result = await doc.parse(mainUri, makeSource('new', 'current', extraBlocks), { backendMode: 'ast(experimental)' });
        doc.applyResult(result);
        const fullPayload = await renderer.renderAsync(doc, { deferFullHtml: true });
        const bibliography = fullPayload.type === 'full'
            ? fullPayload.blocks?.find(block => block.anchors?.includes('ref-current'))
            : undefined;
        assert.ok(bibliography);
        assert.doesNotMatch(bibliography.anchors?.join('\n') ?? '', /ref-(?:real|old|new)/);
    });

    test('uses AST rules from the shared registry in production render', async () => {
        const registry = defineRuleRegistry({
            ...SNAP_TEX_RULES,
            astRenderRules: [
                defineAstRenderRule((input, context) => {
                    if (!isMacroNode(input.node, 'advisor')) { return undefined; }
                    const args = readAstCommandArguments(input);
                    return { html: `<div class="advisor">${context.escapeHtml(args.requiredArgs[0] ?? '')}</div>`, consumedNodes: args.consumedNodes };
                }),
                ...SNAP_TEX_RULES.astRenderRules
            ],
            astMathRules: [
                defineAstMathRule({
                    commands: ['answer'],
                    apply: input => ({ replacement: '42', consumedNodes: input.arguments.consumedNodes })
                }),
                ...SNAP_TEX_RULES.astMathRules
            ]
        });
        const mainUri = new BrowserUri('/project/main.tex');
        const provider = new MemoryFileProvider(new Map([
            [normalizeUri(mainUri), [
                '\\begin{document}',
                '\\advisor{Alice <Advisor>}',
                '$\\answer{\\ref{hidden}}$',
                '\\end{document}'
            ].join('\n')]
        ]));
        const doc = new LatexDocument(provider);
        const result = await doc.parse(mainUri, undefined, { backendMode: 'ast(experimental)' });
        doc.applyResult(result);

        const payload = await new SmartRenderer(registry).renderAsync(doc);
        const html = payload.htmls?.join('') ?? '';

        assert.match(html, /<div class="advisor">Alice &lt;Advisor&gt;<\/div>/);
        assert.match(html, /katex[\s\S]*42/);
        assert.doesNotMatch(html, /\\answer|data-key="hidden"/);
    });

    test('drops comment-only blocks without leaving preview gaps', async () => {
        const mainUri = new BrowserUri('/project/main.tex');
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
        assert.ok(blocks.every(block => stripLatexComments(block).trim().length > 0));
        assert.ok(blocks.some(block => block.includes('Notice that this paragraph')));
        assert.ok(blocks.some(block => block.includes('In Eq.~\\eqref{eq:real}')));
        assert.doesNotMatch(blocks.join('\n'), /eq:commented/);
        assert.match(html, /Notice that this paragraph/);
        assert.match(html, /In Eq\./);
        assert.doesNotMatch(html, /eq:commented|%\\begin|<div class="latex-block"[^>]*>\s*<\/div>/);
    });

    test('drops standalone list boundary blocks without leaving preview gaps', async () => {
        const mainUri = new BrowserUri('/project/main.tex');
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
        const mainUri = new BrowserUri('/project/main.tex');
        const figureUri = new BrowserUri('/project/figures/fold_illus_reliever.tex');
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
    test('keeps float internals inside their outer preview blocks', () => {
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

        assert.equal((html.match(/class="latex-block/g) ?? []).length, 3);
        assert.doesNotMatch(html, /class="latex-block (?:figure|table|algorithm)/);
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
        assert.match(html, /<span style="color: red; --snaptex-latex-color: red">Summary of loss notation/);
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
        assert.match(blockHtml, /<div class="latex-style-scope" style="color: blue; --snaptex-latex-color: blue">[\s\S]*<h2>/);
        assert.match(blockHtml, /Styled Section/);
        assert.match(blockHtml, /<p>[\s\S]*First synthetic paragraph\.<\/p>/);
        assert.match(blockHtml, /<p>Second synthetic paragraph\.<\/p>/);
        assert.match(blockHtml, /<span class="no-indent-marker"><\/span><strong>Proof\.<\/strong>[\s\S]*Proof body\.[\s\S]*QED/);
        assert.match(blockHtml, /<li><span class="latex-list-label">Key<\/span>\s+Labeled item\.<\/li>/);
        assert.match(blockHtml, /<li>Plain item\.<\/li>/);
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

        assert.match(inlineHtml, /<p>Lead sentence before color\. <span style="color: blue; --snaptex-latex-color: blue">Inline continuation with \(\[alpha2026\?\]\)\.<\/span><\/p>/);
        assert.match(inlineHtml, /<\/p>\s*<p><span style="color: blue; --snaptex-latex-color: blue">Second colored paragraph\.<\/span><\/p>/);
        assert.doesNotMatch(inlineHtml, /\\color\{blue\}/);
    });

    test('escapes maketitle metadata while preserving LaTeX formatting', () => {
        const renderer = new SmartRenderer();
        const payload = renderer.render(createDocument(['\\maketitle'], {
            title: '<img src=x onerror=alert(1)> \\textbf{Safe} $x<y$\\footnote{Title note}',
            authors: [{ name: 'Ada & Bob \\quad \\href{https://example.test}{Profile}\\smallskip', emails: [], affiliationIds: [] }],
            date: '\\bigskip 2026 <script>alert(1)</script>'
        }));
        const html = payload.htmls?.join('') ?? '';

        assert.doesNotMatch(html, /<img/i);
        assert.doesNotMatch(html, /<script/i);
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
        assert.match(html, /Ada &amp; Bob/);
        assert.match(html, /href="https:\/\/example\.test\/"[^>]*>Profile<\/a>/);
        assert.doesNotMatch(html, /\\(?:quad|href|smallskip|bigskip)/);
        assert.match(html, /2026 &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.match(html, /<strong>Safe<\/strong>/);
        assert.match(html, /class="katex"/);
        assert.match(html, /<em>\(Title note\)<\/em><br\/>/);
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


    test('renders nested lists and block content inside theorem environments', () => {
        const html = renderBlocks([[
            '\\begin{definition}[Separability of an interval]',
            'For the intervals $(\\tau_l,\\tau_r] \\in G$, we make the following definitions,',
            '\\begin{enumerate}[$G_1:$]',
            '\\item $(\\tau_l,\\tau_r] \\in (0, n]$ is separable.',
            '\\item $(\\tau_l,\\tau_r] \\in (0, n]$ is left-separable.',
            '\\end{enumerate}',
            'Before table.',
            '\\begin{table}',
            '\\begin{tabular}{cc}',
            '\\toprule',
            'A & B \\\\',
            '\\bottomrule',
            '\\end{tabular}',
            '\\end{table}',
            'After table.',
            '\\end{definition}'
        ].join('\n')]);

        assert.match(html, /class="latex-theorem"/);
        assert.match(html, /<ol class="[^"]*\blatex-list\b[^"]*">/);
        assert.equal((html.match(/<li>/g) ?? []).length, 2);
        assert.match(html, /class="latex-list-label">[\s\S]*katex/);
        assert.match(html, /class="latex-theorem"[\s\S]*class="latex-table"[\s\S]*After table\./);
        assert.doesNotMatch(html, /\\begin\{enumerate\}|\\item|SNAP_ENUM_LABEL/);
        assert.doesNotMatch(html, /\\begin\{table\}|\\begin\{tabular\}/);
    });

    test('renders common enumerate label templates', () => {
        const html = renderBlocks([[
            '\\begin{enumerate}[(a)]',
            '\\item Alpha.',
            '\\item Beta.',
            '\\end{enumerate}',
            '',
            '\\begin{enumerate}[(i)]',
            '\\item One.',
            '\\item Two.',
            '\\end{enumerate}',
            '',
            '\\begin{enumerate}[$H_a$]',
            '\\item Gamma.',
            '\\item Delta.',
            '\\end{enumerate}'
        ].join('\n')]);

        assert.match(html, /<span class="latex-list-label">\(a\)<\/span>\s+Alpha/);
        assert.match(html, /<span class="latex-list-label">\(b\)<\/span>\s+Beta/);
        assert.match(html, /<span class="latex-list-label">\(i\)<\/span>\s+One/);
        assert.match(html, /<span class="latex-list-label">\(ii\)<\/span>\s+Two/);
        assert.match(html, /class="latex-list-label">[\s\S]*katex[\s\S]*<\/span>\s+Gamma/);
        assert.match(html, /class="latex-list-label">[\s\S]*katex[\s\S]*<\/span>\s+Delta/);
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
                defineBlockDependencyRule(({ text, deps }) => {
                    collectCount++;
                    if (!text.includes('\\makecover')) { return []; }
                    return [
                        deps.metadata('title'),
                        deps.metadata('custom.editor')
                    ];
                })
            ],
            renderRules: [
                ...SNAP_TEX_RULES.renderRules,
                {
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

    test('renders reference and citation edge cases', () => {
        const doc = createDocument([
            [
                '\\section{Intro}\\label{sec:intro}',
                'See \\ref{sec:intro,fig:missing}, Eq.~\\eqref{eq:one}, \\ref{sec:a&b}, \\citep[see][p. 2]{smith2024,doe2025}, \\citet{smith2024}, \\citealp{smith2024}, \\citealt{doe2025}, and \\citeyear{doe2025}. Also \\citep{undated} and \\citep{missing}.',
                '\\label{sec:a&b}'
            ].join('\n'),
            '\\begin{equation}\\label{eq:one}x=1\\end{equation}',
            '\\bibliographystyle{alpha}'
        ]);
        doc.bibEntries = new Map([
            ['smith2024', { key: 'smith2024', type: 'article', fields: { author: 'Smith, Jane', year: '2024', title: 'A Paper' } }],
            ['doe2025', { key: 'doe2025', type: 'article', fields: { author: 'Doe, John', year: '2025', title: 'Another Paper' } }],
            ['undated', { key: 'undated', type: 'misc', fields: { author: 'Vale, Alex', title: 'Undated Work', year: '' } }]
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
        assert.match(html, /<a href="#ref-smith2024"[^>]*>Smith, 2024<\/a>/);
        assert.match(html, /Doe <a href="#ref-doe2025"[^>]*>2025<\/a>/);
        assert.match(html, /and <a href="#ref-doe2025"[^>]*>2025<\/a>/);
        assert.match(html, /<a href="#ref-undated"[^>]*>Vale, n\.d\.<\/a>/);
        assert.match(html, /\[missing\?\]/);
        assert.doesNotMatch(html, /\\bibliographystyle|alpha/);
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

    test('builds TikZJax input from parsed documents without comment paragraphs', async () => {
        const mainUri = new BrowserUri('/project/main.tex');
        const provider = new MemoryFileProvider(new Map([
            [normalizeUri(mainUri), [
                '\\documentclass{article}',
                '\\usepackage{tikz}',
                '\\definecolor{tikzfontcolor}{HTML}{000000}',
                '\\usetikzlibrary{calc, shapes.geometric, positioning, decorations.pathreplacing, patterns, arrows.meta, backgrounds}',
                '\\tikzset{',
                '  dot/.style={circle, fill=tikzfontcolor, inner sep=1pt, outer sep=0pt},',
                '  % style for every pics named "right angle"',
                '  pics/right angle/.append style={',
                '    /tikz/draw, /tikz/angle radius=5pt',
                '  }',
                '}',
                '\\newcommand{\\htau}{\\hat{\\tau}}',
                '\\begin{document}',
                '\\begin{figure}[H]',
                '\\centering',
                '\\resizebox{\\textwidth}{!}{',
                '\\begin{tikzpicture}',
                '\\path coordinate (A) at (0, 0) coordinate (E) at (15, 0);',
                '\\path coordinate (B) at ($ (A)!.25!(E) $);',
                '\\draw[line width=.5pt] (A) -- (B) -- (E);',
                '\\node[dot, label = {$\\htau_{a}$}] at (A) {};',
                '\\node[dot, label = {$\\tau_{h}^\\ast$}] at (B) {};',
                '\\end{tikzpicture}}',
                '\\end{figure}',
                '\\end{document}'
            ].join('\n')]
        ]));
        const doc = new LatexDocument(provider);
        doc.applyResult(await doc.parse(mainUri));

        const html = new SmartRenderer().render(doc).htmls?.join('\n') ?? '';
        const script = html.match(/<script type="text\/snaptex-tikz"[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '';

        assert.match(script, /\\usetikzlibrary\{calc\}/);
        assert.match(script, /\\def\\htau\{\\hat\{\\tau\}\}/);
        assert.match(script, /%\r?\n[^\S\r\n]*pics\/right angle/);
        assert.doesNotMatch(script, /%\r?\n[^\S\r\n]*\r?\n[^\S\r\n]*pics\/right angle/);
        assert.doesNotMatch(script, /\\resizebox|\\begin\{figure\}/);
    });

    test('prunes TikZ libraries per picture while preserving used global styles', () => {
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

        const styleDoc = createDocument([
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
        const styleHtml = renderer.render(styleDoc).htmls?.join('') ?? '';

        assert.match(styleHtml, /\\usetikzlibrary\{decorations\.pathreplacing\}/);
        assert.doesNotMatch(styleHtml, /positioning/);
        assert.doesNotMatch(styleHtml, /calc/);
    });

    test('uses TikZ preview lowerings while preserving exact arrow tips', () => {
        const renderer = new SmartRenderer();
        const simpleDoc = createDocument([
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
        const simpleHtml = renderer.render(simpleDoc).htmls?.join('') ?? '';

        assert.match(simpleHtml, /\\usetikzlibrary\{positioning\}/);
        assert.match(simpleHtml, /arrow\/\.style=\{->, thick\}/);
        assert.doesNotMatch(simpleHtml, /arrows\.meta/);
        assert.doesNotMatch(simpleHtml, /-Latex/);

        const macroDoc = createDocument(['\\begin{tikzpicture}\\node {$\\btheta$};\\end{tikzpicture}']);
        macroDoc.metadata.tikzMacroMap.set('\\btheta', '\\def\\btheta{\\bm{\\theta}}');
        const macroHtml = renderer.render(macroDoc).htmls?.join('') ?? '';
        assert.match(macroHtml, /\\def\\btheta\{\\boldsymbol\{\\theta\}\}/);
        assert.doesNotMatch(macroHtml, /\\bm\{/);
        assert.match(macroHtml, /data-tex-packages='\{"amsbsy":""\}'/);

        const exactDoc = createDocument([
            [
                '\\begin{tikzpicture}',
                '\\draw[-{Latex[length=3mm]}] (0,0) -- (1,0);',
                '\\end{tikzpicture}'
            ].join('\n')
        ], {
            tikzGlobal: '\\usetikzlibrary{arrows.meta, positioning}'
        });
        const exactHtml = renderer.render(exactDoc).htmls?.join('') ?? '';

        assert.match(exactHtml, /\\usetikzlibrary\{arrows\.meta\}/);
        assert.match(exactHtml, /-\{Latex\[length=3mm\]\}/);
        assert.doesNotMatch(exactHtml, /positioning/);
    });

    test('renders a fixture-backed long document and keeps localized edits as patches', async () => {
        const mainUri = new BrowserUri('/project/long-doc.tex');
        const bibUri = new BrowserUri('/project/refs.bib');
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

suite('Project resource path validation', () => {
    test('resolves resource paths without crossing the opened project root', () => {
        assert.equal(resolveProjectResourcePath('subfold', '../figures/a.pdf'), 'figures/a.pdf');
        assert.equal(resolveProjectResourcePath('', '../figures/a.pdf'), undefined);
        assert.equal(resolveProjectResourcePath('subfold', '../../outside.pdf'), undefined);
        assert.equal(resolveProjectResourcePath('subfold', 'C:\\outside.pdf'), undefined);
        assert.equal(resolveProjectResourcePath('../outside', 'a.pdf'), undefined);
    });

});

