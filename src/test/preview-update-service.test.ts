/// <reference types="mocha" />

import * as assert from 'assert';
import * as vscode from 'vscode';
import { PreviewUpdateService } from '../preview-update-service';
import { defineRuleRegistry, SNAP_TEX_RULES } from '../rules';
import type { PreprocessRule } from '../types';
import { normalizeUri } from '../utils';
import { MemoryFileProvider } from './test-helpers';

suite('PreviewUpdateService', () => {
    const uri = vscode.Uri.file('/project/main.tex');
    const text = [
        '\\begin{document}',
        'First paragraph.',
        '',
        'Second paragraph.',
        '\\end{document}'
    ].join('\n');

    test('renders and transforms eager HTML payloads', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());

        const payload = await service.render(uri, text, {
            deferFullHtml: false,
            transformHtml: html => html.replace('First paragraph.', 'Transformed paragraph.')
        });

        assert.match(payload.htmls?.join('\n') ?? '', /Transformed paragraph/);
    });

    test('keeps lazy block rendering available after deferred payloads', async () => {
        const legacyOnlyRule: PreprocessRule = {
            name: 'test_legacy_only',
            priority: 0,
            apply: (source, renderer) => source.replace(/\\legacyOnly/g, renderer.protectHtml('legacy-test', '<span class="legacy-only">legacy</span>', 'inline'))
        };
        const registry = defineRuleRegistry({
            ...SNAP_TEX_RULES,
            metadataExtractors: [
                {
                    name: 'test-title',
                    extract: source => {
                        const match = /\\testtitle\{([^}]*)\}/.exec(source);
                        return match && match.index !== undefined
                            ? { title: match[1], ranges: [{ start: match.index, end: match.index + match[0].length }] }
                            : {};
                    }
                },
                ...SNAP_TEX_RULES.metadataExtractors
            ],
            renderRules: [legacyOnlyRule, ...SNAP_TEX_RULES.renderRules]
        });
        const service = new PreviewUpdateService(new MemoryFileProvider(), registry);
        const source = [
            '\\begin{document}',
            '\\testtitle{Registry Title}',
            '\\maketitle',
            '\\legacyOnly',
            '\\end{document}'
        ].join('\n');

        const payload = await service.render(uri, source, { deferFullHtml: true });
        const firstBlock = await service.renderBlockByIndex(0);

        assert.ok(payload.blocks);
        assert.match(firstBlock?.html ?? '', /legacy-only/);
        assert.match(firstBlock?.html ?? '', /Registry Title/);
    });

    test('renders lazy TikZ and PDF containers in AST splitter mode', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());
        const payload = await service.render(uri, [
            '\\begin{document}',
            '\\begin{figure}',
            '\\begin{tikzpicture}\\node {A};\\end{tikzpicture}',
            '\\includegraphics{figures/page.pdf}',
            '\\caption{Diagram}',
            '\\end{figure}',
            '\\end{document}'
        ].join('\n'), {
            deferFullHtml: true,
            backendMode: 'ast(experimental)'
        });
        const block = await service.renderBlockByIndex(0);
        const html = block?.html ?? '';

        assert.ok(payload.blocks);
        assert.match(html, /class="tikz-container"/);
        assert.match(html, /type="text\/snaptex-tikz"/);
        assert.match(html, /<canvas[^>]+data-req-path="figures\/page\.pdf"/);
        assert.match(html, /class="figure-caption"/);
    });

    test('renders title, abstract, keywords, citations, and inline bibliography in AST splitter mode', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());
        const payload = await service.render(uri, [
            '\\title{Demo \\textbf{Paper}}',
            '\\author{Alice Example}',
            '\\editor{Casey Editor}',
            '\\begin{document}',
            '\\maketitle',
            '\\Abstract{A short abstract with $x=1$.}',
            '\\Keywords{preview, ast}',
            'See \\citep{doe2024}.',
            '\\begin{thebibliography}{9}',
            '\\bibitem{doe2024} Doe, J. (2024). \\textit{A test paper}.',
            '\\end{thebibliography}',
            '\\end{document}'
        ].join('\n'), {
            deferFullHtml: false,
            backendMode: 'ast(experimental)'
        });
        const html = payload.htmls?.join('\n') ?? '';

        assert.match(html, /class="latex-title">Demo <strong>Paper<\/strong>/);
        assert.doesNotMatch(html, /\\textbf\{Paper\}/);
        assert.match(html, /class="latex-author">Alice Example/);
        assert.match(html, /Casey Editor/);
        assert.match(html, /class="latex-abstract"/);
        assert.match(html, /class="latex-keywords"/);
        assert.match(html, /href="#ref-doe2024"/);
        assert.match(html, /class="latex-bibliography-list"/);
    });

    test('renders nested lists with display math through both preview modes', async () => {
        const source = [
            '\\begin{document}',
            '\\begin{itemize}',
            '\\item First \\textbf{item}.',
            '\\item Nested list:',
            '\\begin{enumerate}[$H_a$]',
            '\\item Inner $x_i$.',
            '\\end{enumerate}',
            '\\item Display math:',
            '\\begin{equation}\\label{eq:list}',
            'x=1',
            '\\end{equation}',
            'where x is defined.',
            '\\end{itemize}',
            '\\end{document}'
        ].join('\n');

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';

            assert.match(html, /<ul class="[^"]*\blatex-list\b[^"]*">/);
            assert.match(html, /<ol class="[^"]*\blatex-list\b[^"]*">/);
            assert.match(html, /First <(?:span style="font-weight: 600"|strong)>item<\/(?:span|strong)>/);
            assert.match(html, /class="latex-list-label">[\s\S]*katex/);
            assert.match(html, /equation-container/);
            assert.match(html, /where x is defined/);
            assert.doesNotMatch(html, /\\begin\{itemize\}|\\begin\{enumerate\}|\\item|\\textbf/);
        }
    });

    test('renders math with preamble macros in AST splitter mode', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());
        const payload = await service.render(uri, [
            '\\newcommand{\\vect}[1]{\\mathbf{#1}}',
            '\\begin{document}',
            '$\\vect{x}$',
            '\\end{document}'
        ].join('\n'), {
            deferFullHtml: false,
            backendMode: 'ast(experimental)'
        });
        const html = payload.htmls?.join('\n') ?? '';

        assert.match(html, /katex/);
        assert.match(html, /mathvariant="bold"|mord mathbf/);
    });

    test('renders a representative document through legacy and AST splitter modes', async () => {
        const source = [
            '\\begin{document}',
            '\\section{Intro}\\label{sec:intro}',
            'See \\ref{sec:intro}, \\eqref{eq:model}, and \\citep{smith2024}.',
            '\\begin{equation}\\label{eq:model}x=1\\end{equation}',
            '\\begin{condition}[Model]\\begin{enumerate}[(i)]\\item First\\end{enumerate}\\end{condition}',
            '\\begin{table}\\begin{tabular}{cc}A & B\\\\\\end{tabular}\\caption{A table}\\end{table}',
            '\\begin{figure}\\begin{tikzpicture}\\node {A};\\end{tikzpicture}\\caption{A figure}\\end{figure}',
            '\\begin{thebibliography}{9}',
            '\\bibitem{smith2024} Smith, A. (2024). Demo.',
            '\\end{thebibliography}',
            '\\end{document}'
        ].join('\n');

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';

            assert.match(html, /Intro/);
            assert.match(html, /data-key="sec:intro"/);
            assert.match(html, /data-key="eq:model"/);
            assert.match(html, /href="#ref-smith2024"/);
            assert.match(html, /class="latex-theorem"/);
            assert.match(html, /<li>/);
            assert.match(html, /\(i\)/);
            assert.match(html, /class="latex-tabular-preview"/);
            assert.match(html, /class="tikz-container"/);
            assert.match(html, /id="ref-smith2024"/);
        }
    });

    test('renders starred section titles with inline math through both preview modes', async () => {
        const source = [
            '\\newcommand{\\Hcal}{\\mathcal{H}}',
            '\\begin{document}',
            '\\subsubsection*{Case 2: $\\Hcal_2 = \\Hcal_3 = \\emptyset$}',
            '\\end{document}'
        ].join('\n');

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';
            const visibleHtml = html.replace(/<annotation\b[\s\S]*?<\/annotation>/g, '');

            assert.match(html, /<h4>/);
            assert.match(html, /Case 2:/);
            assert.match(html, /katex/);
            assert.doesNotMatch(visibleHtml, /data-type="sec"/);
            assert.doesNotMatch(visibleHtml, /<h4>\s*\./);
            assert.doesNotMatch(visibleHtml, /Hcal_|emptyset/);
        }
    });

    test('renders algorithmic commands through both preview modes', async () => {
        const source = [
            '\\newcommand{\\estcps}{\\widehat{\\mathcal T}}',
            '\\begin{document}',
            '\\begin{algorithm}[tb]',
            '\\caption{\\small Cross-fitting framework}',
            '\\label{alg:cf_meta}',
            '\\begin{algorithmic}[1]',
            '\\REQUIRE Data sequence $\\{z_i\\}_{i=1}^n$ and folds $M$.',
            '\\ENSURE Estimated changepoint set $\\estcps$.',
            '\\STATE \\textbf{Loss evaluation:} For each segment $I = (s, e]$.',
            '\\FOR{$m = 1$ \\TO $M$}',
            '    \\IF{$m = 1$}',
            '        \\STATE \\textit{Initialize} $\\hat f_m$.',
            '    \\ENDIF',
            '    \\STATE \\textit{Estimate} $\\hat f_m$.',
            '\\ENDFOR',
            '\\STATE Solve:',
            '\\[',
            '    \\estcps = \\operatorname{argmin}_{\\mathcal T}\\sum_k L_k.',
            '\\]',
            '\\end{algorithmic}',
            '\\end{algorithm}',
            '\\end{document}'
        ].join('\n');

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';

            assert.match(html, /class="latex-algorithm"/);
            assert.match(html, /class="alg-caption"/);
            assert.match(html, /Cross-fitting framework/);
            assert.match(html, /id="alg:cf_meta"/);
            assert.match(html, /<ol class="alg-list">/);
            assert.match(html, /Require:/);
            assert.match(html, /Ensure:/);
            assert.match(html, /Loss evaluation/);
            assert.match(html, /for[\s\S]*to[\s\S]*if[\s\S]*end if[\s\S]*end for/);
            assert.match(html, /katex/);
            assert.match(html, /<li class="alg-item"><strong>Require:/);
            assert.match(html, /<li class="alg-item"><strong>Ensure:/);
            assert.match(html, /style="padding-left: calc\(5px \+ 1\.5em\)">if/);
            assert.match(html, /style="padding-left: calc\(5px \+ 3em\)">[\s\S]*Initialize/);
            assert.match(html, /style="padding-left: calc\(5px \+ 1\.5em\)">[\s\S]*Estimate/);
            assert.ok((html.match(/class="alg-item/g) ?? []).length >= 8);
            assert.doesNotMatch(html, /alg-item-no-marker/);
            assert.doesNotMatch(html, /\\(?:REQUIRE|ENSURE|STATE|FOR|IF|TO|ENDIF|ENDFOR)\b/);
            assert.doesNotMatch(html, /\[(?:tb|1)\]/);
        }
    });

    test('renders nested table captions and labels in AST splitter mode', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());
        const payload = await service.render(uri, [
            '\\begin{document}',
            '\\begin{table}[htb]',
            '\\begin{threeparttable}',
            '\\centering',
            '\\caption{\\small Summary of notation. Here, $\\ell$ denotes individual loss.}',
            '\\label{tab:notation_loss}',
            '\\begin{tabular}{c c l}',
            '\\toprule',
            '\\textbf{Notation} & \\textbf{Definition} & \\textbf{Description} \\\\',
            '\\midrule',
            '$\\ell(z_i; f)$ & -- & Individual loss. \\\\',
            '\\bottomrule',
            '\\end{tabular}',
            '\\begin{tablenotes}[flushleft]\\footnotesize',
            '\\item[$\\dagger$] This note uses $x_i$ and \\textit{style}.',
            '\\end{tablenotes}',
            '\\end{threeparttable}',
            '\\end{table}',
            '\\end{document}'
        ].join('\n'), {
            deferFullHtml: false,
            backendMode: 'ast(experimental)'
        });
        const html = payload.htmls?.join('\n') ?? '';

        assert.match(html, /class="table-caption"/);
        assert.match(html, /Summary of notation/);
        assert.match(html, /latex-tabular-preview/);
        assert.match(html, /class="latex-tablenotes"/);
        assert.match(html, /This note uses/);
        assert.match(html, /font-style: italic[^>]*>style/);
        assert.match(html, /id="tab:notation_loss"/);
        assert.doesNotMatch(html, /\[htb\]/);
    });

    test('renders complex booktabs tables in both backend modes', async () => {
        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, [
                '\\begin{document}',
                '\\begin{table}[!ht]',
                '\\setlength\\tabcolsep{0.6em}',
                '\\begin{threeparttable}',
                '\\caption{Illustrative rendering workload summary for \\textbf{\\snaptex} preview modes.}',
                '\\label{tab:demo-complex-table}',
                '\\centering',
                '\\begin{tabular*}{\\textwidth}{l@{\\extracolsep{\\fill}}lcccc}',
                '\\toprule',
                '&& \\multicolumn{2}{c}{Small document} & \\multicolumn{2}{c}{Large document} \\\\',
                '\\cmidrule(lr){3-4}\\cmidrule(lr){5-6}',
                'Mode & Workload & \\textbf{Blocks} & \\textbf{Latency} & \\textbf{Blocks} & \\textbf{Latency} \\\\',
                '\\midrule',
                '\\multirow{3}{*}{Full render}',
                '& Text + math & 46 & $38\\,ms$ & 620 & $410\\,ms$ \\\\',
                '& Figures & 8 & $92\\,ms$ & 74 & $1.8\\,s$\\tnote{$\\dagger$} \\\\',
                '& Tables & \\multicolumn{2}{c}{\\{tabular, booktabs\\}} & \\multicolumn{2}{c}{\\{tabular*, makecell, notes\\}} \\\\',
                '\\cline{2-6}',
                '\\multirow{3}{*}{Patch render}',
                '& Inline edit & 1 & $12\\,ms$ & 1 & $15\\,ms$ \\\\',
                '& Local equation & 2 & $19\\,ms$ & 2 & $24\\,ms$ \\\\',
                '& Local table cell & \\makecell{$\\Delta r=1$,\\\\ $\\Delta c=2$} & $31\\,ms$ & \\makecell{$\\Delta r=1$,\\\\ $\\Delta c=4$} & $37\\,ms$ \\\\',
                '\\cline{2-6}',
                '\\multirow{2}{*}{Virtual mode}',
                '& Mounted range & \\makecell{viewport,\\\\ tooltips} & $18\\,ms$ & \\makecell{viewport,\\\\ refs + tooltips} & $22\\,ms$\\tnote{$\\ddagger$} \\\\',
                '& Released range & \\multicolumn{2}{c}{offscreen PDF canvases} & \\multicolumn{2}{c}{far-offscreen PDF + TikZ blocks} \\\\',
                '\\bottomrule',
                '\\end{tabular*}',
                '\\begin{tablenotes}[flushleft]\\footnotesize',
                '    \\item[$\\dagger$] Numbers are invented for this demo; the row shows how a table note marker is rendered in a cell.',
                '    \\item[$\\ddagger$] Virtual mode keeps only viewport-near blocks mounted while preserving anchors for references and tooltips.',
                '\\end{tablenotes}',
                '\\end{threeparttable}',
                '\\end{table}',
                '\\end{document}'
            ].join('\n'), {
                deferFullHtml: false,
                backendMode
            });
            const html = payload.htmls?.join('\n') ?? '';

            assert.match(html, /class="latex-tabular-preview latex-tabular-booktabs"/);
            assert.match(html, /colspan="2"/);
            assert.match(html, /rowspan="3"/);
            assert.doesNotMatch(html, /<tr><td><\/td><td>Figures/);
            assert.doesNotMatch(html, /<tr><td><\/td><td>Tables/);
            assert.match(html, /<tr><td>Figures<\/td><td>8<\/td>/);
            assert.match(html, /<tr><td>Tables<\/td><td colspan="2"[^>]*>\{tabular, booktabs\}<\/td>/);
            assert.match(html, /class="latex-makecell"/);
            assert.match(html, /class="latex-tnote"/);
            assert.match(html, /class="latex-tablenotes"/);
            assert.match(html, /Virtual mode keeps only viewport-near blocks/);
            assert.match(html, /id="tab:demo-complex-table"/);
            assert.doesNotMatch(html, /\\(?:cmidrule|cline|multirow|multicolumn|makecell|tnote)\b/);
            assert.doesNotMatch(html, /\[!ht\]|\\(?:begin|end)\{(?:threeparttable|tabular\*)\}/);
        }
    });

    test('renders TikZ inside AST float wrappers', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());
        const payload = await service.render(uri, [
            '\\usepackage{tikz}',
            '\\usetikzlibrary{calc}',
            '\\newcommand{\\htau}{\\widehat{\\tau}}',
            '\\tikzset{dot/.style={circle, fill=black, inner sep=1pt, outer sep=0pt}}',
            '\\begin{document}',
            '\\begin{figure}[H]',
            '\\centering',
            '\\resizebox{\\textwidth}{!}{',
            '\\begin{tikzpicture}',
            '\\path coordinate (A) at (0, 0)',
            '      coordinate (F) at (15, 0);',
            '\\path coordinate (H) at ($ (A)!.02!(F) $)',
            '      coordinate (I) at ($ (A)!.98!(F) $);',
            '\\draw[line width=.5pt] (A) -- (H) -- (I) -- (F);',
            '\\node[dot, label = {-90:$\\htau_{a-1}$}] at (A) {};',
            '\\node[dot, label = {150:$\\tau_{h+t+1}^\\ast$}] at (I) {};',
            '\\node[dot, label = {-80:$\\htau_{a+2}$}] at (F) {};',
            '\\end{tikzpicture}}',
            '\\caption{A TikZ figure}',
            '\\end{figure}',
            '\\end{document}'
        ].join('\n'), {
            deferFullHtml: false,
            backendMode: 'ast(experimental)'
        });
        const html = payload.htmls?.join('\n') ?? '';

        assert.match(html, /class="tikz-container"/);
        assert.match(html, /type="text\/snaptex-tikz"/);
        assert.match(html, /\\begin\{tikzpicture\}/);
        assert.match(html, /\\usetikzlibrary\{calc\}/);
        assert.match(html, /label = \{-80:\$\\htau_\{a\+2\}\$\}\] at \(F\) \{\};/);
        assert.match(html, /class="figure-caption"/);
        assert.doesNotMatch(html, /\[H\]/);
    });

    test('renders subfigures in both backend modes', async () => {
        const source = [
            '\\begin{document}',
            '\\begin{figure}[htbp]',
            '\\centering',
            '\\begin{subfigure}{0.48\\textwidth}',
            '\\centering',
            '\\includegraphics[width=\\linewidth]{fig1.pdf}',
            '\\caption{First figure}',
            '\\label{fig:sub1}',
            '\\end{subfigure}',
            '\\hfill',
            '\\begin{subfigure}{0.48\\textwidth}',
            '\\centering',
            '\\includegraphics[width=\\linewidth]{fig2.pdf}',
            '\\caption{Second figure}',
            '\\label{fig:sub2}',
            '\\end{subfigure}',
            '\\caption{Two subfigures in one row.}',
            '\\label{fig:two-subfigures}',
            '\\end{figure}',
            '',
            '\\begin{figure}[htbp]',
            '\\centering',
            '\\begin{subfigure}{0.48\\textwidth}',
            '\\centering',
            '\\includegraphics[width=\\linewidth]{fig1.pdf}',
            '\\caption{First figure}',
            '\\label{fig:sub1b}',
            '\\end{subfigure}',
            '\\hfill',
            '\\begin{subfigure}{0.48\\textwidth}',
            '\\centering',
            '\\includegraphics[width=\\linewidth]{fig2.pdf}',
            '\\caption{Second figure}',
            '\\label{fig:sub2b}',
            '\\end{subfigure}',
            '\\vspace{0.3cm}',
            '\\begin{subfigure}{0.48\\textwidth}',
            '\\centering',
            '\\includegraphics[width=\\linewidth]{fig3.pdf}',
            '\\caption{Third figure}',
            '\\label{fig:sub3}',
            '\\end{subfigure}',
            '\\hfill',
            '\\begin{subfigure}{0.48\\textwidth}',
            '\\centering',
            '\\includegraphics[width=\\linewidth]{fig4.pdf}',
            '\\caption{Fourth figure}',
            '\\label{fig:sub4}',
            '\\end{subfigure}',
            '\\caption{Four subfigures arranged in a $2 \\times 2$ layout.}',
            '\\label{fig:four-subfigures}',
            '\\end{figure}',
            '\\end{document}'
        ].join('\n');

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';

            assert.equal((html.match(/class="latex-subfigure"/g) ?? []).length, 6);
            assert.match(html, /class="latex-subfigure-grid"/);
            assert.match(html, /class="subfigure-caption"[^>]*>\(<span class="sn-cnt" data-type="subfig"><\/span>\) First figure/);
            assert.match(html, /class="subfigure-caption"[^>]*>\(<span class="sn-cnt" data-type="subfig"><\/span>\) Fourth figure/);
            assert.match(html, /<strong>Figure <span class="sn-cnt" data-type="fig"><\/span>:<\/strong> Two subfigures in one row\./);
            assert.match(html, /Four subfigures arranged in a/);
            assert.match(html, /id="fig:sub1"/);
            assert.match(html, /id="fig:four-subfigures"/);
            assert.equal(payload.numbering.labels['fig:two-subfigures'], '1');
            assert.equal(payload.numbering.labels['fig:sub1'], '1a');
            assert.equal(payload.numbering.labels['fig:sub2'], '1b');
            assert.equal(payload.numbering.labels['fig:four-subfigures'], '2');
            assert.equal(payload.numbering.labels['fig:sub3'], '2c');
            assert.equal(payload.numbering.labels['fig:sub4'], '2d');
            assert.doesNotMatch(html, /\\(?:begin|end)\{subfigure\}|\\hfill|\\vspace|\[htbp\]/);
        }
    });

    test('renders AST-split color groups across display math and theorem environments', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());
        const payload = await service.render(uri, [
            '\\begin{document}',
            '{\\color{blue}Intro before display math.',
            '\\[',
            'x=1',
            '\\]',
            'continuation after display math.',
            '',
            '\\begin{remark}[A note]',
            'Remark body.',
            '\\begin{equation*}',
            'y=2',
            '\\end{equation*}',
            'Remark tail.',
            '\\end{remark}',
            '',
            'final colored paragraph',
            '}',
            '\\end{document}'
        ].join('\n'), {
            deferFullHtml: false,
            backendMode: 'ast(experimental)'
        });
        const html = payload.htmls?.join('\n') ?? '';

        assert.doesNotMatch(html, /\{\\color/);
        assert.match(html, /<span style="color: blue">Intro before display math/);
        assert.match(html, /<div class="latex-style-scope" style="color: blue">[\s\S]*Remark body/);
        assert.match(html, /<span style="color: blue">final colored paragraph\s*<\/span>/);
    });

    test('renders nested color groups inside AST-split theorem blocks', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());
        const payload = await service.render(uri, [
            '\\begin{document}',
            '{\\color{blue}',
            '\\begin{theorem}\\label{thm:nested-color}',
            'Assume ${\\color{blue}\\rho_n=(\\log n)^2}$.',
            '{\\color{blue}This sentence is still buffered.}',
            '',
            'Similarly, the result holds {\\color{blue}for the buffered fits}.',
            '\\end{theorem}',
            '',
            'After theorem.',
            '}',
            '\\end{document}'
        ].join('\n'), {
            deferFullHtml: false,
            backendMode: 'ast(experimental)'
        });
        const html = payload.htmls?.join('\n') ?? '';
        const visibleHtml = html.replace(/<annotation\b[\s\S]*?<\/annotation>/g, '');

        assert.doesNotMatch(visibleHtml, /\{\\color/);
        assert.match(visibleHtml, /<div class="latex-style-scope" style="color: blue">[\s\S]*latex-theorem/);
        assert.match(visibleHtml, /This sentence is still buffered/);
        assert.match(visibleHtml, /for the buffered fits/);
        assert.match(visibleHtml, /After theorem/);
    });

    test('renders AST-split colored sections as markdown headings', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());
        const payload = await service.render(uri, [
            '\\begin{document}',
            '{\\color{blue}',
            '\\section{Numerical studies}\\label{sec:simul}',
            '',
            '\\subsection{Common experimental setup}\\label{sec:simul_setup}',
            '}',
            '\\end{document}'
        ].join('\n'), {
            deferFullHtml: false,
            backendMode: 'ast(experimental)'
        });
        const html = payload.htmls?.join('\n') ?? '';

        assert.doesNotMatch(html, /<p><span style="color: blue">##/);
        assert.match(html, /<div class="latex-style-scope" style="color: blue">[\s\S]*<h2>/);
        assert.match(html, /<h2>[\s\S]*Numerical studies[\s\S]*<\/h2>/);
        assert.match(html, /<h3>[\s\S]*Common experimental setup[\s\S]*<\/h3>/);
    });

    test('keeps display-math continuations unindented in AST splitter mode', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());
        const payload = await service.render(uri, [
            '\\begin{document}',
            'Before equation:',
            '\\begin{equation}\\label{eq:test}',
            'x=1',
            '\\end{equation}',
            'where the equation is explained.',
            '',
            'Next paragraph.',
            '\\end{document}'
        ].join('\n'), {
            deferFullHtml: false,
            backendMode: 'ast(experimental)'
        });
        const htmls = payload.htmls ?? [];
        const continuationHtml = htmls.find(html => html.includes('where the equation is explained.')) ?? '';
        const nextParagraphHtml = htmls.find(html => html.includes('Next paragraph.')) ?? '';

        assert.match(continuationHtml, /no-indent-marker/);
        assert.doesNotMatch(nextParagraphHtml, /no-indent-marker/);
    });

    test('does not let later display-math continuations unindent previous paragraphs in AST splitter mode', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());
        const payload = await service.render(uri, [
            '\\begin{document}',
            'Traditional paragraph.',
            'With one more line.',
            '$$x=1$$',
            'where x is explained.',
            '\\end{document}'
        ].join('\n'), {
            deferFullHtml: false,
            backendMode: 'ast(experimental)'
        });
        const htmls = payload.htmls ?? [];
        const traditionalHtml = htmls.find(html => html.includes('Traditional paragraph.')) ?? '';
        const continuationHtml = htmls.find(html => html.includes('where x is explained.')) ?? '';

        assert.match(traditionalHtml, /<p>Traditional paragraph\./);
        assert.doesNotMatch(traditionalHtml, /no-indent-marker/);
        assert.match(continuationHtml, /no-indent-marker/);
    });

    test('renders proof wrappers after AST splitter recurses into long proof content', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());
        const payload = await service.render(uri, [
            '\\begin{document}',
            '\\begin{proof}[Sketch]',
            'First step.',
            '',
            '\\begin{equation}',
            'x=1',
            '\\end{equation}',
            'where x is defined.',
            '',
            'Last step.',
            '\\end{proof}',
            '\\end{document}'
        ].join('\n'), {
            deferFullHtml: false,
            backendMode: 'ast(experimental)'
        });
        const html = payload.htmls?.join('\n') ?? '';

        assert.match(html, /<strong>Proof \(Sketch\)\.<\/strong>/);
        assert.match(html, /First step\./);
        assert.match(html, /where x is defined\./);
        assert.match(html, /Last step\./);
        assert.match(html, /QED/);
        assert.doesNotMatch(html, /\\begin\{proof\}|\\end\{proof\}/);
    });

    test('keeps sync indices correct when inserting a paragraph before an unchanged block', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());
        const body = [
            'Recent years have seen a surge in flexible changepoint models.',
            'Examples include regression, graphical models, and nonparametric methods.',
            'These detection approaches integrate advanced model fitting techniques.',
            'Table S1 summarizes representative complex changepoint models.',
            'In many cases, uniform consistency remains relevant for consistent changepoint estimation.',
            'For example, lasso estimators can approximate their population counterparts.'
        ].join('\n');
        const wrap = (text: string) => [
            '\\begin{document}',
            text,
            '\\end{document}'
        ].join('\n');

        await service.render(uri, wrap(body), {
            deferFullHtml: false,
            backendMode: 'ast(experimental)'
        });
        await service.render(uri, wrap(body.replace('In many cases,', '\nIn many cases,')), {
            deferFullHtml: false,
            backendMode: 'ast(experimental)'
        });
        const edited = wrap(body.replace(
            'In many cases,',
            '\nInserted bridge paragraph for testing.\n\nIn many cases,'
        ));
        const payload = await service.render(uri, edited, {
            deferFullHtml: false,
            backendMode: 'ast(experimental)'
        });
        const targetLine = edited.split('\n').findIndex(line => line.startsWith('In many cases,'));
        const syncData = service.getPreviewSyncData(uri.toString(), targetLine);

        assert.equal(payload.type, 'patch');
        if (payload.type !== 'patch') {
            throw new Error('Expected patch payload');
        }
        assert.equal(payload.start, 1);
        assert.equal(payload.deleteCount, 0);
        assert.equal(payload.htmls.length, 1);
        assert.equal(payload.shift, 1);
        assert.deepEqual(syncData, { index: 2, ratio: 0 });
    });

    test('warms AST hints for patched blocks before returning', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());
        const base = [
            '\\begin{document}',
            'line 0',
            'line 1',
            'line 2',
            'line 3',
            'line 4',
            'line 5',
            'line 6',
            'line 7 plain text.',
            'line 8',
            '\\end{document}'
        ].join('\n');
        const updated = base.replace('line 7 plain text.', 'line 7 see \\ref{target}.');

        await service.render(uri, base, { deferFullHtml: true, backendMode: 'ast(experimental)' });
        const payload = await service.render(uri, updated, { deferFullHtml: true, backendMode: 'ast(experimental)' });
        const sourceSync = service.getSourceSyncData(0, 0.55);

        assert.equal(payload.type, 'patch');
        assert.equal(sourceSync?.line, 8);
    });

    test('maps included-file sync positions through both preview modes', async () => {
        const mainUri = vscode.Uri.file('/project/main.tex');
        const partUri = vscode.Uri.file('/project/sections/part.tex');
        const source = [
            '\\begin{document}',
            'Before.',
            '',
            '\\input{sections/part}',
            '',
            'After.',
            '\\end{document}'
        ].join('\n');
        const files = new Map([[normalizeUri(partUri), [
            'Included start.',
            '',
            'Included target.',
            '',
            'Included end.'
        ].join('\n')]]);

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider(files));
            await service.render(mainUri, source, { deferFullHtml: true, backendMode });

            const preview = service.getPreviewSyncData(partUri.toString(), 2);
            assert.ok(preview);

            const sourceLoc = service.getSourceSyncData(preview.index, preview.ratio);
            assert.ok(sourceLoc);
            assert.equal(normalizeUri(sourceLoc.file), normalizeUri(partUri));
            assert.equal(sourceLoc.line, 2);
        }
    });

    test('ignores commented document markers when mapping source lines', async () => {
        const source = [
            '% \\begin{document}',
            '% old draft content',
            '\\title{Example}',
            '\\begin{document}',
            'First paragraph.',
            '',
            'Second paragraph.',
            '\\end{document}'
        ].join('\n');

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            await service.render(uri, source, { deferFullHtml: true, backendMode });

            assert.equal(service.getPreviewSyncData(uri.toString(), 4)?.index, 0);
            assert.equal(service.getPreviewSyncData(uri.toString(), 6)?.index, 1);
        }
    });

    test('maps block start, middle, and end ratios through both preview modes', async () => {
        const source = [
            '\\begin{document}',
            'Line one.',
            'Line two.',
            'Line three.',
            'Line four.',
            '\\end{document}'
        ].join('\n');

        const linesByBackend: number[][] = [];
        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            await service.render(uri, source, { deferFullHtml: true, backendMode });

            const lines = [0, 0.5, 0.99].map(ratio => service.getSourceSyncData(0, ratio)?.line);
            assert.ok(lines.every(line => typeof line === 'number'));
            assert.ok((lines[0] ?? 0) <= (lines[1] ?? 0));
            assert.ok((lines[1] ?? 0) <= (lines[2] ?? 0));
            assert.ok((lines[2] ?? 0) > (lines[0] ?? 0));
            linesByBackend.push(lines as number[]);
        }
        assert.deepEqual(linesByBackend[1], linesByBackend[0]);
    });

    test('uses AST source anchors for inline math sync', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());
        const source = [
            '\\begin{document}',
            'Plain opening line.',
            'Formula line has $x+y$ in the middle.',
            'Plain closing line.',
            '\\end{document}'
        ].join('\n');

        await service.render(uri, source, { deferFullHtml: true, backendMode: 'ast(experimental)' });
        await service.renderBlockByIndex(0);
        const preview = service.getPreviewSyncData(uri.toString(), 2, 'Formula line has $x'.length);

        assert.ok(preview?.sourceStart !== undefined);
        assert.ok(preview?.sourceEnd !== undefined);

        const sourceLoc = service.getSourceSyncData(preview.index, 0, [], preview.sourceStart, preview.sourceEnd);
        assert.equal(sourceLoc?.line, 2);
    });
});
