/// <reference types="mocha" />

import * as assert from 'assert';
import { BrowserFileProvider, BrowserUri } from '../../apps/standalone/src/browser-file-provider';
import { PreviewUpdateService } from '../preview-update-service';
import { renderLatexBlockWithAst } from '../ast/renderer';
import { createDefaultAstRenderContext } from '../ast/rules';
import { defineRuleRegistry, SNAP_TEX_RULES } from '../rules';
import type { PreprocessRule } from '../types';
import { normalizeUri } from '../utils';
import { MemoryFileProvider } from './test-helpers';

suite('PreviewUpdateService', () => {
    const uri = new BrowserUri('/project/main.tex');

    test('escapes source HTML while retaining generated formatting in both backends', async () => {
        const source = [
            '\\begin{document}',
            'Plain <img src=x onerror=alert(1)> and \\textbf{bold <script>alert(2)</script>}.',
            '\\begin{theorem}<script>alert(1)</script> and \\emph{safe}.\\end{theorem}',
            '\\begin{figure}<script>alert(3)</script> and \\textit{styled}.\\end{figure}',
            '\\end{document}'
        ].join('\n');
        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';
            assert.doesNotMatch(html, /<img|<script/i);
            assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
            assert.match(html, /bold &lt;script&gt;alert\(2\)&lt;\/script&gt;/);
            assert.match(html, /(?:<strong>|<span[^>]*font-weight: (?:600|bold)[^>]*>)bold /);
            assert.match(html, /class="latex-theorem"/);
            assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
            assert.match(html, /(?:<em>|<span[^>]*font-style: italic[^>]*>)safe/);
            assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt; and /);
            assert.match(html, /(?:<em>|<span[^>]*font-style: italic[^>]*>)styled/);
        }
    });

    test('renders safe links and rejects executable URLs in both backends', async () => {
        const source = [
            '\\begin{document}',
            'See \\href{https://example.test/path?q=1&lang=en}{A \\textbf{site}} and \\url{https://example.test/docs?a=1&b=2}.',
            '\\href{javascript:alert(1)}{bad <script>alert(1)</script>} \\url{javascript:alert(2)}',
            '',
            '$\\href{javascript:alert(1)}{bad}$',
            '\\end{document}'
        ].join('\n');
        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';
            assert.match(html, /href="https:\/\/example\.test\/path\?q=1&amp;lang=en"[^>]*rel="noopener noreferrer"/);
            assert.match(html, /href="https:\/\/example\.test\/docs\?a=1&amp;b=2"/);
            assert.doesNotMatch(html, /href="javascript:|<script/i);
            assert.match(html, /bad &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
            assert.match(html, /javascript:alert\(2\)/);
            const textHtml = payload.htmls?.find(block => block.includes('See ')) ?? '';
            assert.doesNotMatch(textHtml, /\\href|\\url/);
        }
    });

    test('escapes image and PDF request attributes in both backends', async () => {
        const source = [
            '\\begin{document}',
            '\\begin{figure}',
            '\\includegraphics{figures/a" onerror="alert(1).pdf}',
            '\\includegraphics{figures/b" onload="alert(1).png}',
            '\\end{figure}',
            '\\end{document}'
        ].join('\n');
        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';
            assert.match(html, /data-req-path="figures\/a&quot; onerror=&quot;alert\(1\)\.pdf"/);
            assert.match(html, /src="LOCAL_IMG:figures\/b&quot; onload=&quot;alert\(1\)\.png"/);
            assert.doesNotMatch(html, /\s(?:onerror|onload)="/i);
        }
    });

    test('updates unchanged math after preamble edits and transforms eager HTML in both backends', async () => {
        const source = [
            '\\newcommand{\\power}[1]{#1^2}',
            '\\begin{document}',
            'First paragraph $\\power{x}$.',
            '',
            'Second paragraph $\\power{y}$.',
            '\\end{document}'
        ].join('\n');
        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            for (const exponent of ['2', '3', '2']) {
                const payload = await service.render(uri, source.replace('#1^2', '#1^' + exponent), {
                    deferFullHtml: false, backendMode,
                    transformHtml: html => html.replace('First paragraph', 'Transformed paragraph')
                });
                const html = payload.htmls?.join('\n') ?? '';
                assert.match(html, /Transformed paragraph/);
                assert.equal((html.match(new RegExp('<mn>' + exponent + '</mn>', 'g')) ?? []).length, 2);
                assert.doesNotMatch(html, /katex-error/);
            }
        }
    });

    test('keeps lazy block rendering available after deferred payloads', async () => {
        const legacyOnlyRule: PreprocessRule = {
            priority: 0,
            apply: (source, renderer) => source.replace(/\\legacyOnly/g, renderer.protectHtml('legacy-test', '<span class="legacy-only">legacy</span>', 'inline'))
        };
        const registry = defineRuleRegistry({
            ...SNAP_TEX_RULES,
            metadataExtractors: [
                source => {
                    const match = /\\testtitle\{([^}]*)\}/.exec(source);
                    return match && match.index !== undefined
                        ? { title: match[1], ranges: [{ start: match.index, end: match.index + match[0].length }] }
                        : {};
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
    for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
        test(`renders front matter and inline bibliography through ${backendMode}`, async () => {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, [
                '\\title{\\Large\\bf Demo \\textbf{Paper}\\footnotemark[2]}',
                '\\author{Alice Example}',
                '\\editor{Casey Editor}',
                '\\begin{document}',
                '\\maketitle',
                '\\Abstract{A \\textbf{short} abstract with $x=1$.}',
                '\\Keywords{preview, ast}',
                '\\begin{acks}Support statement.\\end{acks}',
                'See \\citep{doe2024}.',
                '\\begin{thebibliography}{9}',
                '\\bibitem{doe2024} Doe, J. (2024). \\textit{A test paper}.',
                '\\end{thebibliography}',
                '\\end{document}'
            ].join('\n'), {
                deferFullHtml: false,
                backendMode
            });
            const html = payload.htmls?.join('\n') ?? '';

            assert.match(html, /class="latex-title">[\s\S]*Demo[\s\S]*Paper[\s\S]*<\/h1>/);
            assert.doesNotMatch(html, /\\(?:Large|bf|textbf)\b/);
            assert.doesNotMatch(html, /\\footnotemark/);
            assert.doesNotMatch(html, /\\editor\b/);
            assert.match(html, /class="latex-author">Alice Example/);
            assert.match(html, /Casey Editor/);
            assert.match(html, /class="latex-abstract"/);
            assert.match(html, /class="latex-abstract"[\s\S]*A [\s\S]*short[\s\S]* abstract/);
            assert.doesNotMatch(html, /\\textbf\{short\}/);
            assert.match(html, /class="latex-keywords"/);
            assert.match(html, /class="latex-acknowledgments"[\s\S]*Support statement/);
            assert.match(html, /href="#ref-doe2024"/);
            assert.match(html, /class="latex-bibliography-list"/);
        });
    }
    test('renders external bibliographies in both backend modes', async () => {
        const bibUri = new BrowserUri('/project/refs.bib');
        const provider = new MemoryFileProvider(new Map([
            [normalizeUri(bibUri), '@article{doe2024, author={Doe, Jane}, title={Example $\\sqrt{n}$}, year={2024}}']
        ]));
        for (const [preamble, citation, bibliography] of [
            ['', '\\citep{doe2024}', '\\bibliography{refs}'],
            ['\\addbibresource{refs.bib}', '\\textcite{doe2024} and \\parencite{doe2024}', '\\printbibliography[heading=bibintoc]']
        ]) {
            const source = [preamble, '\\begin{document}', `See ${citation}.`, bibliography, '\\end{document}']
                .filter(Boolean)
                .join('\n');
            for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
                const service = new PreviewUpdateService(provider);
                const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
                const html = payload.htmls?.join('\n') ?? '';

                assert.match(html, /class="latex-bibliography-list"/);
                assert.match(html, /class="katex"/);
                assert.doesNotMatch(html, /No citations found|\\(?:addbibresource|printbibliography|textcite|parencite)/);
                assert.doesNotMatch(html.replace(/<annotation\b[\s\S]*?<\/annotation>/g, ''), /\\sqrt/);
            }
        }
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
            assert.match(html, /First (?:<strong>item<\/strong>|<span[^>]*font-weight: (?:600|bold)[^>]*>item<\/span>)/);
            assert.match(html, /class="latex-list-label">[\s\S]*katex/);
            assert.match(html, /equation-container/);
            assert.match(html, /<span class="eq-no"/);
            assert.match(html, /id="eq:list"/);
            assert.doesNotMatch(html, /&lt;div class=&quot;equation-container/);
            assert.match(html, /where x is defined/);
            assert.doesNotMatch(html, /\\begin\{itemize\}|\\begin\{enumerate\}|\\item|\\textbf/);
        }
    });

    test('preserves AST control-word boundaries across comments', async () => {
        const source = '\\unknown% first comment\n% second comment\nText and plain% comment\ntext.';
        const { html } = await renderLatexBlockWithAst(source);

        assert.match(html, /\\unknown Text and plaintext\./);
        assert.doesNotMatch(html, /\\unknownText/);
    });

    test('omits comment environments in both backend modes', async () => {
        const source = [
            '\\newcommand{\\Verify}{\\textsc{Verify}}',
            '\\begin{document}',
            'Visible before.',
            '\\begin{comment}',
            '\\begin{theorem}Hidden theorem.\\end{theorem}',
            '',
            '\\begin{itemize}\\item Hidden item.\\end{itemize}',
            '\\end{comment}',
            'Visible after.',
            '\\end{document}'
        ].join('\n');

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';

            assert.match(html, /Visible before/);
            assert.match(html, /Visible after/);
            assert.doesNotMatch(html, /Hidden|\\begin\{comment\}|\\end\{comment\}/);
        }
    });

    test('resolves stateful macro aliases and semantic wrappers in both backend modes', async () => {
        const source = [
            '\\let\\oldnu\\nu',
            '\\newcommand{\\symbolmark}{A}',
            '\\let\\oldsymbolmark\\symbolmark',
            '\\renewcommand{\\symbolmark}{B\\oldsymbolmark}',
            '\\newcommand{\\newlink}[2]{{\\protect\\hyperlink{#1}{\\normalcolor #2}}}',
            '\\def\\Hy@raisedlink@left#1{\\ifvmode#1\\else\\penalty100 #1\\fi}',
            '\\newcommand{\\newtarget}[2]{\\Hy@raisedlink@left{\\hypertarget{#1}{}}#2}',
            '\\newcommand{\\linkofproof}[1]{\\textbf{of \\ref{#1}. }\\newtarget{proof:#1}}',
            '\\renewcommand{\\nu}{\\newlink{def:nu}{\\oldnu}}',
            '\\begin{document}',
            'A \\newtarget{target}visible target, $\\nu$, and $\\symbolmark$.',
            '\\begin{proof}\\linkofproof{thm:x}',
            'Visible proof body.',
            '\\end{proof}',
            '\\end{document}'
        ].join('\n');

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';
            const visibleHtml = html.replace(/<annotation\b[\s\S]*?<\/annotation>/g, '');
            const visibleText = visibleHtml.replace(/<[^>]+>/g, '');

            assert.match(visibleHtml, /visible target/);
            assert.match(visibleText, /BA/);
            assert.doesNotMatch(visibleHtml, /\\(?:newtarget|oldnu|Hy@raisedlink@left|hypertarget|penalty|ifvmode|fi)/);
            assert.doesNotMatch(html, /katex-error/);
        }
    });

    test('preserves nested math, TeX shorthand, and preamble macros in AST mode', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());
        const payload = await service.render(uri, [
            '\\newcommand{\\vect}[1]{\\mathbf{#1}}',
            '\\newcommand{\\rbf}{\\mathbf{r}}',
            '\\def\\second#1#2{#2}',
            '\\newcommand{\\linkedq}{\\second{ignored}{q}}',
            '\\newcommand{\\tightnorm}[1]{\\left\\lVert#1\\right.\\kern-\\nulldelimiterspace}',
            '\\newcommand{\\expectation}[2][P]{\\mathbb{E}_{#1}[#2]}',
            '\\newcommand{\\newlink}[2]{{\\protect\\hyperlink{#1}{\\normalcolor #2}}}',
            '\\def\\Hy@raisedlink@left#1{\\unsupportedinternal{#1}}',
            '\\newcommand{\\newtarget}[2]{\\Hy@raisedlink@left{\\hypertarget{#1}{}}#2}',
            '\\newcommand{\\independent}{\\mathpalette{\\independentSymbol}{\\perp}}',
            '\\DeclarePairedDelimiter{\\abs}{\\lvert}{\\rvert}',
            '\\DeclarePairedDelimiterX{\\inner}[2]{\\langle}{\\rangle}{#1,#2}',
            '\\def\\independentSymbol#1#2{\\mathrel{\\rlap{$#1#2$}\\mkern2mu{#1#2}}}',
            '\\def\\beq{\\begin{eqnarray}}',
            '\\def\\eeq{\\end{eqnarray}}',
            '\\begin{document}',
            'Let $\\mathbb P$, $\\mathds{1}$, $\\mathbbm{R}$, $\\mathbf v$, $\\ell_{\\linkedq}$, $\\tightnorm{x}$, $\\expectation{X}$, $\\expectation[Q]{Y}$, $\\newlink{def:x}{O_{p,q}}$, $\\newtarget{def:y}{Y}$, and $X\\independent Y$ be given.',
            '\\[\\mathcal L(\\vect{x}) = \\mathbb P + \\abs*{x} + \\inner{x}{y} + \\Bar{X} + \\Tilde{Y} + \\Tr(A)\\]',
            '\\beq y &=& 1 \\eeq',
            '\\begin{IEEEeqnarray}{rCl} \\IEEEeqnarraymulticol{3}{l}{z = 2} \\end{IEEEeqnarray}',
            '\\[\\scalebox{0.8}{$\\begin{array}{@{}cc@{}} a & b \\\\ c & d \\end{array}$}\\]',
            '\\begin{equation}',
            '\\begin{aligned}',
            '\\frac{\\Rmnum{1}}{2}\\|\\rbf-\\vect{x}_1\\|_2^2 &= \\frac12\\left\\{1 + 1\\right\\}+\\mbox{bold \\textbf{note}}+C_{\\ref*{eq:model}},\\\\',
            '\\vect{x}_2 &= 2.',
            '\\end{aligned}',
            '\\end{equation}',
            '\\end{document}'
        ].join('\n'), {
            deferFullHtml: false,
            backendMode: 'ast(experimental)'
        });
        const html = payload.htmls?.join('\n') ?? '';
        const visibleHtml = html.replace(/<annotation\b[\s\S]*?<\/annotation>/g, '');

        assert.match(html, /katex/);
        assert.match(html, /mathvariant="bold"|mord mathbf/);
        assert.match(html, /data-key="eq:model"/);
        assert.doesNotMatch(html, /katex-error/);
        assert.doesNotMatch(visibleHtml, /\\(?:Rmnum|mbox|mathds|mathbbm|Bar|Tilde|Tr)/);
        assert.doesNotMatch(html, /\\mathbb P\$/);
    });

    test('renders text macros in both backend modes', async () => {
        const source = [
            '\\definecolor{brand}{HTML}{663399}',
            '\\definecolor{accent}{rgb}{0.2,0.4,0.8}',
            '\\newcommand{\\brandtext}[1]{{\\color{brand}#1}}',
            '\\begin{document}',
            'Plain \\brandtext{colored \\textbf{text}}, \\textcolor{accent}{accent}, \\textcolor{brand!25!accent}{mixed}, \\textcolor[RGB]{255,0,0}{direct}, \\textsuperscript{super}, \\textsuperscript{\\textdagger}, \\raisebox{.5ex}[1em][0pt]{raised}, \\phantom{hidden}, \\L{}ojasiewicz, Y{\\i}ld{\\i}r{\\i}m, \\textemdash, \\textdagger, \\copyright, \\textregistered, \\textquotesingle, joined\\xspace words, thin\\thinspace space, \\allowbreak and \\S 2, \\phantomsection\\nolinebreak \\enquote{quoted}, \\fbox{boxed}, \\ovalbox{oval}, \\num{51}, \\SI{2.1}{\\giga\\hertz}, $a\\centernot=b$, $x\\nolinebreak\\xspace y$, $\\nicefrac{1}{2}+\\sfrac{1}{3}$, and $\\qty{38}{\\milli\\meter}$.',
            '\\captionof{figure}{Standalone caption}',
            'Footnote markers: \\footnote[7]{footnote note}, \\footnotemark[8]\\footnotetext[8]{detached note}, and \\thanks{support note}.',
            '\\end{document}'
        ].join('\n');

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';
            const visibleHtml = html.replace(/<annotation\b[\s\S]*?<\/annotation>/g, '');

            assert.match(html, /--snaptex-latex-color: #663399/);
            assert.match(html, /--snaptex-latex-color: rgb\(51 102 204\)/);
            assert.match(html, /--snaptex-latex-color: color-mix\(in srgb, #663399 25%, rgb\(51 102 204\)\)/);
            assert.match(html, /--snaptex-latex-color: rgb\(255 0 0\)/);
            assert.match(html, /colored [\s\S]*(?:<strong>text<\/strong>|<span[^>]*font-weight: (?:600|bold)[^>]*>text<\/span>)/);
            assert.match(html, /<sup(?:\s[^>]*)?>super<\/sup>|vertical-align: super[^>]*>super/);
            assert.match(html, /<sup(?:\s[^>]*)?>†<\/sup>|vertical-align: super[^>]*>†/);
            assert.match(html, /raised/);
            assert.match(html, /visibility: hidden[^>]*>hidden/);
            assert.match(html, /Standalone caption/);
            assert.match(html, /<em>\(footnote note\)<\/em>/);
            assert.match(html, /<em>\(detached note\)<\/em>/);
            assert.match(html, /<em>\(support note\)<\/em>/);
            assert.doesNotMatch(visibleHtml, /\\(?:footnote|footnotemark|footnotetext|thanks)\b/);
            assert.match(html, /Yıldırım/);
            assert.match(html, /—, †, ©, ®, (?:'|&#39;), joined\s+words, thin  space/);
            assert.match(html, /§ 2/);
            assert.match(html, /“quoted”, boxed, oval/);
            assert.match(html, /51/);
            assert.match(html, /2\.1/);
            assert.match(html, /38/);
            assert.doesNotMatch(visibleHtml, /\\brandtext|\\color|\\textcolor|\\textbf|\\textsuperscript|\\captionof|\\(?:raisebox|phantom|L|i|textemdash|textdagger|copyright|textregistered|textquotesingle|xspace|thinspace|allowbreak|phantomsection|nolinebreak|S|enquote|fbox|ovalbox|num|SI|centernot|nicefrac|sfrac|qty|giga|hertz|milli|meter)\b/);

            const updated = await service.render(uri, source.replace('663399', '8844AA'), { deferFullHtml: false, backendMode });
            assert.match(updated.htmls?.join('\n') ?? '', /--snaptex-latex-color: #8844AA/);
        }
    });

    test('reuses built-in rendering for simple local package definitions', async () => {
        const source = [
            '\\usepackage{custom}',
            '\\begin{document}',
            '\\begin{assumptionB}\\label{assumption:custom}Regularity holds.\\end{assumptionB}',
            '\\begin{enumalpha}\\item First case.\\item Second case.\\end{enumalpha}',
            '\\begin{revision}Visible revision.\\end{revision}',
            '\\begin{reviewtext}Styled review.\\end{reviewtext}',
            '\\begin{remarks}\\item First remark.\\item Second remark.\\end{remarks}',
            '\\begin{boxednote}First box paragraph.',
            '',
            'Second box paragraph.\\end{boxednote}',
            '\\nfeq{x = y}',
            '\\end{document}'
        ].join('\n');
        const definitions = [
            '\\newtheorem{assumptionB}{B.}',
            '\\newenvironment{enumalpha}{\\begin{enumerate}[label=(\\alph*)]}{\\end{enumerate}}',
            '\\newenvironment{revision}{}{}',
            '\\newenvironment{reviewtext}{\\color{blue}\\ignorespaces}{\\ignorespacesafterend}',
            '\\newenvironment{remarks}{\\noindent\\textbf{Remarks.}\\begin{itemize}}{\\end{itemize}\\par}',
            '\\newtcolorbox{boxednote}{colback=blue!5}',
            '\\providecommand{\\nfeq}[1]{\\begin{equation*}#1\\end{equation*}}'
        ].join('\n');
        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const files = new Map<string, string>();
            const provider = new MemoryFileProvider(files);
            const service = new PreviewUpdateService(provider);
            await service.render(uri, source, { deferFullHtml: false, backendMode });
            files.set(normalizeUri(new BrowserUri('/project/custom.sty')), definitions);
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';

            assert.match(html, /B\. <span class="sn-cnt" data-type="thm">[\s\S]*Regularity holds/);
            assert.match(html, /latex-list-custom-label[\s\S]*\(a\)[\s\S]*First case[\s\S]*\(b\)[\s\S]*Second case/);
            assert.match(html, /Visible revision/);
            assert.match(html, /color: blue[\s\S]*Styled review/);
            assert.match(html, /Remarks\.[\s\S]*First remark[\s\S]*Second remark/);
            assert.match(html, /First box paragraph/);
            assert.match(html, /Second box paragraph/);
            assert.match(html, /class="katex-display"[\s\S]*x[\s\S]*=[\s\S]*y/);
            assert.doesNotMatch(html, /\\(?:begin|end)(?:boxednote|\{(?:assumptionB|enumalpha|revision|reviewtext|remarks|boxednote|equation\*)\})|\\nfeq|\\item\b/);
            assert.equal(payload.numbering.labels['assumption:custom'], '1');
        }
    });

    test('renders block content wrapped by user text macros in both backend modes', async () => {
        const source = [
            '\\newcommand{\\styledblock}[1]{{\\color{blue}#1}}',
            '\\begin{document}',
            '\\styledblock{',
            '\\begin{table*}[t]',
            '\\caption{Styled table}',
            '\\begin{tabular}{cc}',
            'A & B \\\\',
            '\\end{tabular}',
            '\\end{table*}',
            '}',
            '\\end{document}'
        ].join('\n');

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';

            assert.match(html, /class="latex-table"/);
            assert.match(html, /color: blue/);
            assert.doesNotMatch(html, /\\styledblock|\\begin\{table\*\}/);
        }
    });

    test('renders a representative document through legacy and AST splitter modes', async () => {
        const source = [
            '\\newcommand{\\markword}{\\textbf{verified}}',
            '\\begin{document}',
            '\\section{Overview}\\label{sec:overview}',
            'See Section~\\ref{sec:overview}, \\citep{smith2024}, and equation~\\eqref{eq:bound}. A \\markword result.',
            '\\begin{equation}\\label{eq:bound}x=1\\end{equation}',
            '\\begin{condition}[Model case]',
            '\\begin{enumerate}[(i)]',
            '\\item A nested item.',
            '\\end{enumerate}',
            '\\end{condition}',
            '\\begin{table}',
            '\\begin{tabular}{cc}A & B \\\\ C & D\\end{tabular}',
            '\\caption{Summary}',
            '\\end{table}',
            '\\begin{figure}',
            '\\begin{tikzpicture}\\node {A};\\end{tikzpicture}',
            '\\caption{Diagram}',
            '\\end{figure}',
            '\\begin{thebibliography}{9}',
            '\\bibitem{smith2024} Smith, A. (2024). Demo.',
            '\\end{thebibliography}',
            '\\end{document}'
        ].join('\n');

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';

            assert.match(html, /data-key="sec:overview"/);
            assert.match(html, /data-key="eq:bound"/);
            assert.match(html, /href="#ref-smith2024"/);
            assert.match(html, /id="ref-smith2024"/);
            assert.match(html, /verified/);
            assert.match(html, /class="latex-theorem"/);
            assert.match(html, /class="latex-list-label">[\s\S]*\(i\)/);
            assert.match(html, /class="latex-table"/);
            assert.match(html, /class="tikz-container"/);
            assert.equal((html.match(/class="latex-block"/g) ?? []).length, payload.htmls?.length);
            assert.doesNotMatch(html, /katex-error|\\(?:newcommand|section|ref|citep|caption|item)\b/);
        }
    });

    test('renders starred section titles with inline math through both preview modes', async () => {
        const source = [
            '\\newcommand{\\Hcal}{\\mathcal{H}}',
            '\\renewcommand\\paragraph{\\@startsection{paragraph}{4}{\\z@}{1ex}{-1em}{\\itshape}}',
            '\\begin{document}',
            '\\subsubsection*{Case 2: $\\Hcal_2 = \\Hcal_3 = \\emptyset$}',
            '\\paragraph{Semantic heading}Body.',
            '\\end{document}'
        ].join('\n');

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';
            const visibleHtml = html.replace(/<annotation\b[\s\S]*?<\/annotation>/g, '');

            assert.match(html, /<h4>/);
            assert.match(html, /<h5>[\s\S]*Semantic heading/);
            assert.match(html, /Case 2:/);
            assert.match(html, /katex/);
            assert.doesNotMatch(visibleHtml, /data-type="sec"/);
            assert.doesNotMatch(visibleHtml, /<h4>\s*\./);
            assert.doesNotMatch(visibleHtml, /Hcal_|emptyset/);
            assert.doesNotMatch(visibleHtml, /@startsection|\\z@/);
        }
    });

    test('renders algorithmic commands through both preview modes', async () => {
        const source = [
            '\\newcommand{\\estcps}{\\widehat{\\mathcal T}}',
            '\\algnewcommand\\Inferred{\\item[\\textbf{Inferred:}]}',
            '\\begin{document}',
            '\\begin{algorithm}[tb]',
            '\\caption{\\small Cross-fitting framework}',
            '\\label[algorithm]{alg:cf_meta}',
            '\\begin{algorithmic}[1]',
            '\\REQUIRE Data sequence $\\{z_i\\}_{i=1}^n$ and folds $M$.',
            '\\ENSURE Estimated changepoint set $\\estcps$.',
            '\\Inferred Latent state $z$.',
            '\\STATE \\textbf{Loss evaluation:} For each segment $I = (s, e]$.\\label{alg:step}',
            '\\STATE Initialize the estimate. \\Comment{warm start}',
            '\\FOR{$m = 1$ \\TO $M$}',
            '    \\IF{$m = 1$}',
            '        \\STATE \\textit{Initialize} $\\hat f_m$.',
            '    \\ENDIF',
            '    \\STATE \\textit{Estimate} $\\hat f_m$.',
            '\\ENDFOR',
            '\\STATE Solve:',
            '\\STATEX Continue with the selected candidate.',
            '\\STATE \\RETURN $\\estcps$.',
            '\\[',
            '    \\estcps = \\operatorname{argmin}_{\\mathcal T}\\sum_k L_k.',
            '\\]',
            '\\end{algorithmic}',
            '\\end{algorithm}',
            '\\begin{algorithm}',
            '\\caption{Nested algorithm2e syntax}',
            '\\label{alg:nested}',
            '\\DontPrintSemicolon',
            '\\SetKwInOut{Input}{Input}',
            '\\SetKwInOut{Output}{Output}',
            '\\Input{Custom data $z$}',
            '\\Output{Custom result $r$}',
            '\\KwIn{Data $x$}',
            '\\KwOut{Result $y$}',
            'Compare Algorithm~\\ref{alg:cf_meta} with Eqs.~\\eqref{eq:first}--\\eqref{eq:second}\\;',
            '\\For{$i=1$ \\KwTo $n$}{Process $x_i$\\;\\If{$x_i>0$}{\\Return{$x_i$}\\;}}',
            '\\end{algorithm}',
            '\\end{document}'
        ].join('\n');

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';

            assert.match(html, /class="latex-algorithm"/);
            assert.equal((html.match(/class="latex-block"/g) ?? []).length, payload.htmls?.length);
            assert.match(html, /class="alg-caption"/);
            assert.match(html, /Cross-fitting framework/);
            assert.match(html, /id="alg:cf_meta"/);
            assert.match(html, /id="alg:step"/);
            assert.match(html, /id="alg:nested"/);
            assert.match(html, /data-key="alg:cf_meta"/);
            assert.match(html, /data-key="eq:first"/);
            assert.match(html, /data-key="eq:second"/);
            assert.match(html, /<ol class="alg-list">/);
            assert.match(html, /Require:/);
            assert.match(html, /Ensure:/);
            assert.match(html, /Loss evaluation/);
            assert.match(html, /<em>\(warm start\)<\/em>/);
            assert.match(html, /for[\s\S]*to[\s\S]*if[\s\S]*end if[\s\S]*end for/);
            assert.match(html, /return/);
            assert.match(html, /Input:[\s\S]*Custom data/);
            assert.match(html, /Output:[\s\S]*Custom result/);
            assert.doesNotMatch(html, /\\RETURN/);
            assert.match(html, /katex/);
            assert.match(html, /<li class="alg-item"><strong>Require:/);
            assert.match(html, /<li class="alg-item"><strong>Ensure:/);
            assert.match(html, /<li class="alg-item">[\s\S]*Inferred:[\s\S]*Latent state/);
            assert.match(html, /style="padding-left: calc\(5px \+ 1\.5em\)">if/);
            assert.match(html, /style="padding-left: calc\(5px \+ 3em\)">[\s\S]*Initialize/);
            assert.match(html, /style="padding-left: calc\(5px \+ 1\.5em\)">[\s\S]*Estimate/);
            assert.ok((html.match(/class="alg-item/g) ?? []).length >= 8);
            assert.doesNotMatch(html, /alg-item-no-marker/);
            assert.doesNotMatch(html, /\\(?:REQUIRE|ENSURE|STATE|STATEX|FOR|IF|TO|ENDIF|ENDFOR|Comment|Inferred|item|label)\b/);
            assert.doesNotMatch(html, /\\(?:KwIn|KwOut|KwTo|For|If|Return|DontPrintSemicolon|SetKwInOut|Input|Output)\b/);
            assert.doesNotMatch(html, /\[(?:tb|1)\]/);
        }
        let mathCalls = 0;
        await renderLatexBlockWithAst(source, {
            context: createDefaultAstRenderContext({
                sourceText: source,
                renderMath: () => { mathCalls++; return '<span>formula</span>'; }
            })
        });
        assert.equal(mathCalls, 21, 'each algorithm formula must render only once');
    });
    test('renders complex booktabs tables in both backend modes', async () => {
        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, [
                '\\begin{document}',
                '\\begin{table}[!ht]',
                '\\setlength\\tabcolsep{0.6em}',
                '\\begin{threeparttable}',
                '\\caption{\\small Illustrative rendering workload summary for \\textbf{SnapTeX} preview modes, including $x_i$.}',
                '\\label{tab:demo-complex-table}',
                '\\centering',
                '\\begin{tabular*}{\\textwidth}{l@{\\extracolsep{\\fill}}lcccc}',
                '\\toprule',
                '&& \\multicolumn{2}{c}{Small document} & \\multicolumn{2}{c}{Large document} \\\\',
                '\\cmidrule(lr){3-4}\\cmidrule(lr){5-6}',
                'Mode & Workload & \\textbf{Blocks} & \\textbf{Latency} & \\textbf{Blocks} & \\textbf{Latency} \\\\',
                '\\hhline{|=|=|=|=|=|=|}',
                '\\midrule',
                '\\multirow{3}{*}{Full render}',
                '& Text + math & 46 & $38\\,ms$ & 620 & $410\\,ms$ \\\\',
                '& Figures & 8 & $92\\,ms$ & 74 \\includegraphics[width=.2\\linewidth]{figures/sample.png} & $1.8\\,s$\\tnote{$\\dagger$} \\\\',
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
                '    \\item[$\\dagger$] Numbers are invented for this demo; the row shows a \\textit{styled note} using $x_i$.',
                '    \\item[$\\ddagger$] Virtual mode keeps only viewport-near blocks mounted while preserving anchors for references and tooltips.',
                '\\end{tablenotes}',
                '\\end{threeparttable}',
                '\\end{table}',
                '\\newcolumntype{P}[1]{>{\\raggedright\\arraybackslash}p{#1}}',
                '\\begin{longtable}[]{P{.3\\columnwidth}ll}',
                '\\caption{Long table summary}\\label{tab:long}\\tabularnewline\\noalign{}',
                '\\toprule',
                'Name & Value & Note\\tabularnewline',
                '\\midrule\\endhead',
                'Alpha & $1$ & First\\tabularnewline',
                'Beta & $2$ & Second\\tabularnewline',
                '\\bottomrule',
                '\\end{longtable}',
                '\\end{document}'
            ].join('\n'), {
                deferFullHtml: false,
                backendMode
            });
            const html = payload.htmls?.join('\n') ?? '';

            assert.match(html, /class="latex-tabular-preview latex-tabular-booktabs"/);
            const captionHtml = /class="table-caption"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
            assert.match(captionHtml, /Illustrative rendering workload summary/);
            assert.match(captionHtml, /class="katex"/);
            assert.match(html, /(?:<em>|<span[^>]*font-style: italic[^>]*>)styled note/);
            assert.doesNotMatch(html, /\\(?:caption|small|textit)\b/);
            assert.match(html, /colspan="2"/);
            assert.match(html, /rowspan="3"/);
            assert.match(html, /<t[dh][^>]+colspan="2"[^>]*>Small document<\/t[dh]>/);
            assert.doesNotMatch(html, /<tr><td><\/td><td>Figures/);
            assert.doesNotMatch(html, /<tr><td><\/td><td>Tables/);
            assert.match(html, /<tr><td>Figures<\/td><td>8<\/td>/);
            assert.match(html, /figures\/sample\.png/);
            assert.match(html, /<tr><td>Tables<\/td><td colspan="2"[^>]*>\{tabular, booktabs\}<\/td>/);
            assert.match(html, /class="latex-makecell"/);
            assert.match(html, /class="latex-tnote"/);
            assert.match(html, /class="latex-tablenotes"/);
            assert.match(html, /<div class="latex-tablenotes"><ul><li class="note-item"/);
            assert.match(html, /Virtual mode keeps only viewport-near blocks/);
            assert.match(html, /id="tab:demo-complex-table"/);
            assert.match(html, /Long table summary/);
            assert.match(html, /<tr class="table-row-rule-above"><td>Alpha<\/td><td>.*1.*<\/td><td>First<\/td><\/tr>/s);
            assert.match(html, /id="tab:long"/);
            assert.doesNotMatch(html, /\\(?:cmidrule|cline|hhline|multirow|multicolumn|makecell|tnote|includegraphics|textwidth|columnwidth|hsize|arraybackslash|newcolumntype|noalign)\b/);
            assert.doesNotMatch(html, /\[!ht\]|\\(?:begin|end)\{(?:threeparttable|tabular\*|longtable)\}|\\(?:tabularnewline|endhead)\b/);
        }
    });

    test('preserves full and column-range table rules in both backends', async () => {
        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, [
                '\\begin{document}',
                '\\begin{table}\\begin{tabular}{lcccccccc}',
                '\\hline',
                '& \\multicolumn{4}{c}{Small} & \\multicolumn{4}{c}{Large} \\\\',
                '\\cline{2-5}\\cline{6-9}',
                '& \\multicolumn{2}{c}{A} & \\multicolumn{2}{c}{B} & \\multicolumn{2}{c}{C} & \\multicolumn{2}{c}{D} \\\\',
                '\\cmidrule[1pt](lr){2-3}\\cline{4-5}\\cline{6-7}\\cline{8-9}',
                'Method & Size & Power & Size & Power & Size & Power & Size & Power \\\\',
                '\\hline',
                'PL-SS & 1 & 2 & 3 & 4 & 5 & 6 & 7 & 8 \\\\',
                '\\midrule[1pt]',
                'SM-SS & 1 & 2 & 3 & 4 & 5 & 6 & 7 & 8 \\\\',
                '\\cline{2-3}\\cline{4-5}',
                'Joined & \\multicolumn{4}{c}{Whole span} & & & & \\\\',
                '\\bottomrule[1.5pt]',
                '\\end{tabular}\\end{table}',
                '\\end{document}'
            ].join('\n'), { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('') ?? '';
            const rows = [...html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)];
            assert.equal(rows.length, 6);
            for (const index of [0, 3, 4]) {
                assert.match(rows[index][1], /table-row-rule-above/, `${backendMode}: full rule at row ${index}`);
            }
            for (const [index, count] of [[1, 4], [2, 8]]) {
                assert.doesNotMatch(rows[index][1], /table-row-rule-above/);
                assert.equal((rows[index][2].match(/data-rule-above/g) ?? []).length, count);
                assert.match(rows[index][2], /^<t[dh](?: scope="col")?>/, 'The first column is outside the partial rules');
            }
            assert.match(rows[5][2], /<t[dh] data-rule-above[^>]*colspan="4"[^>]*>Whole span<\/t[dh]>/,
                'Adjacent ranges together cover a spanning cell');
            assert.doesNotMatch(html, /\\(?:hline|cline|cmidrule|midrule|bottomrule)\b|\[1(?:\.5)?pt\]|\(lr\)/);
        }
    });

    test('renders deferred TikZ and PDF float content through both backends', async () => {
        const source = [
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
            '\\includegraphics{figures/page.pdf}',
            '\\caption{A TikZ figure}',
            '\\end{figure}',
            '\\begin{equation}\\begin{tikzcd}A \\arrow[r] & B\\end{tikzcd}\\end{equation}',
            '\\begin{center}\\includegraphics{figures/standalone.png}\\captionof{figure}{Standalone figure}\\end{center}',
            '\\end{document}'
        ].join('\n');
        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: true, backendMode });
            assert.equal(payload.type, 'full');
            assert.equal(payload.htmls?.length ?? 0, 0, 'Deferred loading must not eagerly render the document');
            const htmls: string[] = [];
            for (const block of payload.blocks ?? []) {
                const rendered = await service.renderBlockByIndex(block.index);
                assert.ok(rendered && typeof rendered.html === 'string');
                htmls.push(rendered.html);
            }
            const html = htmls.join('\n');
            assert.match(html, /class="tikz-container"/);
            assert.match(html, /type="text\/snaptex-tikz"/);
            assert.match(html, /\\begin\{tikzpicture\}/);
            assert.match(html, /\\usetikzlibrary\{calc\}/);
            assert.match(html, /data-tex-packages='\{"tikz-cd":""\}'/);
            assert.match(html, /\\begin\{tikzcd\}/);
            assert.match(html, /label = \{-80:\$\\htau_\{a\+2\}\$\}\] at \(F\) \{\};/);
            assert.match(html, /<canvas[^>]+data-req-path="figures\/page\.pdf"/);
            assert.match(html, /class="figure-caption"/);
            assert.match(html, /src="LOCAL_IMG:figures\/standalone\.png"/);
            assert.match(html, /Standalone figure/);
            assert.doesNotMatch(html, /\[H\]|\\(?:resizebox|includegraphics|captionof)\b/);
        }
    });

    test('resolves citation commands inside TikZ in both backend modes', async () => {
        const bibUri = new BrowserUri('/project/refs.bib');
        const provider = new MemoryFileProvider(new Map([
            [normalizeUri(bibUri), [
                '@article{alpha, author={Alpha, Ada}, title={First}, year={2024}}',
                '@article{beta, author={Beta, Bob}, title={Second}, year={2025}}'
            ].join('\n')]
        ]));
        const source = [
            '\\begin{document}',
            'See \\cite{alpha}.',
            '',
            '\\begin{figure}',
            '\\begin{tikzpicture}',
            '\\node {\\cite{beta}};',
            '\\node {\\citep{beta}};',
            '\\node {\\citet{beta}};',
            '\\node {\\citeyear{beta}};',
            '\\node {[\\citenum{beta}]};',
            '\\end{tikzpicture}',
            '\\end{figure}',
            '\\bibliography{refs}',
            '\\end{document}'
        ].join('\n');

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(provider);
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';

            assert.match(html, /\\node \{\(Beta, 2025\)\};/);
            assert.match(html, /\\node \{Beta \(2025\)\};/);
            assert.match(html, /\\node \{2025\};/);
            assert.match(html, /\\node \{\[2\]\};/);
            assert.doesNotMatch(html, /\\cite/);
        }
    });

    test('renders subfigures in both backend modes', async () => {
        const source = [
            '\\begin{document}',
            '\\begin{figure}[htbp]',
            '\\centering',
            '\\begin{subfigure}',
            '\\centering',
            '\\includegraphics*[width=\\linewidth]{fig1.pdf}',
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
            '',
            '\\begin{figure}',
            '\\subfloat[Macro first.\\label{fig:macro1}]{{\\includegraphics[width=0.45\\textwidth]{fig1.pdf}}}',
            '\\subcaptionbox{Macro second.\\label{fig:macro2}}[.48\\textwidth]{\\includegraphics[width=\\linewidth]{fig2.pdf}}',
            '\\subfigure[Macro third.\\label{fig:macro3}]{\\includegraphics[width=.48\\textwidth]{fig1.pdf}}',
            '\\caption{Macro subfigures.}',
            '\\label{fig:macro-subfigures}',
            '\\end{figure}',
            '\\end{document}'
        ].join('\n');

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';

            assert.equal((html.match(/class="latex-subfigure"/g) ?? []).length, 9);
            assert.match(html, /class="latex-subfigure" style="flex: 1 1 100%; max-width: 100%;"/);
            assert.match(html, /class="latex-subfigure-grid"/);
            assert.match(html, /class="subfigure-caption"[^>]*>\(<span class="sn-cnt" data-type="subfig"><\/span>\) First figure/);
            assert.match(html, /class="subfigure-caption"[^>]*>\(<span class="sn-cnt" data-type="subfig"><\/span>\) Fourth figure/);
            assert.match(html, /<strong>Figure <span class="sn-cnt" data-type="fig"><\/span>:<\/strong> Two subfigures in one row\./);
            assert.match(html, /Four subfigures arranged in a/);
            assert.match(html, /Macro first[\s\S]*Macro second/);
            assert.match(html, /id="fig:sub1"/);
            assert.match(html, /id="fig:four-subfigures"/);
            assert.equal(payload.numbering.labels['fig:two-subfigures'], '1');
            assert.equal(payload.numbering.labels['fig:sub1'], '1a');
            assert.equal(payload.numbering.labels['fig:sub2'], '1b');
            assert.equal(payload.numbering.labels['fig:four-subfigures'], '2');
            assert.equal(payload.numbering.labels['fig:sub3'], '2c');
            assert.equal(payload.numbering.labels['fig:sub4'], '2d');
            assert.equal(payload.numbering.labels['fig:macro-subfigures'], '3');
            assert.equal(payload.numbering.labels['fig:macro1'], '3a');
            assert.equal(payload.numbering.labels['fig:macro2'], '3b');
            assert.equal(payload.numbering.labels['fig:macro3'], '3c');
            assert.equal((html.match(/data-req-path="fig1\.pdf"/g) ?? []).length, 4);
            assert.doesNotMatch(html, /\\(?:begin|end)\{subfigure\}|\\(?:subfloat|subfigure|subcaptionbox)\b|\\hfill|\\vspace|\[htbp\]/);
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
        assert.match(html, /<span style="color: blue; --snaptex-latex-color: blue">Intro before display math/);
        assert.match(html, /<div class="latex-style-scope" style="color: blue; --snaptex-latex-color: blue">[\s\S]*Remark body/);
        assert.match(html, /<span style="color: blue; --snaptex-latex-color: blue">final colored paragraph\s*<\/span>/);
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
        assert.match(visibleHtml, /<div class="latex-style-scope" style="color: blue; --snaptex-latex-color: blue">[\s\S]*latex-theorem/);
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

        assert.doesNotMatch(html, /<p><span style="color: blue; --snaptex-latex-color: blue">##/);
        assert.match(html, /<div class="latex-style-scope" style="color: blue; --snaptex-latex-color: blue">[\s\S]*<h2>/);
        assert.match(html, /<h2>[\s\S]*Numerical studies[\s\S]*<\/h2>/);
        assert.match(html, /<h3>[\s\S]*Common experimental setup[\s\S]*<\/h3>/);
    });

    test('limits no-indent markers to display-math continuations in both backends', async () => {
        const source = [
            '\\begin{document}',
            'Before equation:',
            '\\begin{equation}\\label{eq:test}',
            'x=1',
            '\\end{equation}',
            'where the equation is explained.',
            '',
            'Next paragraph.',
            'With one more line.',
            '$$y=2$$',
            'where y is explained.',
            '\\end{document}'
        ].join('\n');
        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const htmls = payload.htmls ?? [];
            assert.match(htmls.find(html => html.includes('where the equation is explained.')) ?? '', /no-indent-marker/);
            const nextParagraphHtml = htmls.find(html => html.includes('Next paragraph.')) ?? '';
            assert.match(nextParagraphHtml, /<p>Next paragraph\./);
            assert.doesNotMatch(nextParagraphHtml, /no-indent-marker/);
            assert.match(htmls.find(html => html.includes('where y is explained.')) ?? '', /no-indent-marker/);
        }
    });

    test('renders proof wrappers after AST splitter recurses into long proof content', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());
        const payload = await service.render(uri, [
            '\\begin{document}',
            '\\begin{theorem}\\label{thm:proof-target}Claim.\\end{theorem}',
            '\\begin{proof}[Proof of Theorem~\\ref{thm:proof-target}]',
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

        assert.match(html, /<strong>Proof \(Proof of Theorem&nbsp;<a[^>]*data-key="thm:proof-target"[^>]*>\?<\/a>\)\.<\/strong>/);
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

    test('stores AST hints for patched blocks before returning', async () => {
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
        const previewSync = service.getPreviewSyncData(uri.toString(), 8, 'line 7 see \\ref'.length);

        assert.equal(payload.type, 'patch');
        assert.ok(previewSync?.sourceStart !== undefined && previewSync.sourceEnd !== undefined);
        assert.equal(previewSync.sourceEnd - previewSync.sourceStart, '\\ref{target}'.length);
        assert.deepEqual(service.getSourceSyncData(previewSync.index, previewSync.ratio, {
            sourceStart: previewSync.sourceStart, sourceEnd: previewSync.sourceEnd
        }), { file: uri.toString(), line: 8 });
    });

    test('reuses AST hints only while source and parse status still match', async () => {
        const source = 'See $x$ \\label{first}.';
        const first = await renderLatexBlockWithAst(source);
        const repeated = await renderLatexBlockWithAst(source, { artifact: first.artifact });
        assert.strictEqual(repeated.artifact, first.artifact);
        assert.equal(repeated.html, first.html);

        const changed = await renderLatexBlockWithAst('Longer text $y$ \\label{second}.', { artifact: first.artifact });
        assert.notStrictEqual(changed.artifact, first.artifact);
        assert.deepEqual(changed.artifact.metadata.labels, ['second']);
        assert.notDeepEqual(changed.artifact.sourceHints, first.artifact.sourceHints);

        const failed = await renderLatexBlockWithAst(source, {
            artifact: first.artifact,
            parse: async () => ({ errors: [{ message: 'Parse unavailable' }] })
        });
        assert.equal(failed.artifact.parseOk, false);
        assert.equal(failed.artifact.sourceHints.starts.length, 0);
    });

    test('keeps included-file sync positions current after CRLF edits in both backends', async () => {
        const mainUri = new BrowserUri('/project/main.tex');
        const partUri = new BrowserUri('/project/sections/part.tex');
        const source = [
            '\\begin{document}',
            'Before.',
            '',
            '\\input{sections/part}',
            '',
            'After.',
            '\\end{document}'
        ].join('\r\n');
        const part = [
            '% \\begin{document}',
            'Included start with 50\\% and 中文.',
            '',
            'Included target.',
            '',
            'Included end.'
        ].join('\r\n');

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const provider = new BrowserFileProvider();
            provider.setProjectFiles([{ path: partUri.path, text: part }]);
            const service = new PreviewUpdateService(provider);
            for (const edited of [part, part.replace('Included target.', 'Inserted paragraph.\r\n\r\nIncluded target.'), part]) {
                provider.setFile(partUri, edited);
                await service.render(mainUri, source, { deferFullHtml: false, backendMode });
                for (const [file, line] of [
                    [partUri, edited.split('\r\n').indexOf('Included target.')],
                    [mainUri, 5]
                ] as const) {
                    const preview = service.getPreviewSyncData(file.toString(), line);
                    assert.ok(preview);
                    const sourceLoc = service.getSourceSyncData(preview.index, preview.ratio);
                    assert.ok(sourceLoc);
                    assert.equal(normalizeUri(sourceLoc.file), normalizeUri(file));
                    assert.equal(sourceLoc.line, line);
                }
                const preview = service.getPreviewSyncData(partUri.toString(), 1);
                assert.ok(preview);
                assert.match((await service.renderBlockByIndex(preview.index))?.html ?? '', /50(?:%|&#37;) and 中文/);
            }
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

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            await service.render(uri, source, { deferFullHtml: true, backendMode });

            const lines = [0, 0.5, 1].map(ratio => service.getSourceSyncData(0, ratio)?.line);
            assert.deepEqual(lines, [0, 3, 5], backendMode);
        }
    });

    test('renders adjacent display math without shifting later source lines', async () => {
        const source = [
            '\\begin{document}',
            '$$a=1$$',
            '$$b=2$$',
            'where b is explained.',
            '',
            'Target after the displays.',
            '\\end{document}'
        ].join('\n');

        for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
            const service = new PreviewUpdateService(new MemoryFileProvider());
            const payload = await service.render(uri, source, { deferFullHtml: false, backendMode });
            const html = payload.htmls?.join('\n') ?? '';
            const displayBlocks = payload.htmls?.filter(block => block.includes('class="katex-display"')) ?? [];
            const preview = service.getPreviewSyncData(uri.toString(), 5, 0);

            assert.equal((html.match(/class="katex-display"/g) ?? []).length, 2);
            assert.equal(displayBlocks.length, 2);
            assert.doesNotMatch(displayBlocks[0], /where b is explained/);
            assert.match(displayBlocks[1], /where b is explained/);
            assert.match(displayBlocks[1], /no-indent-marker/);
            assert.ok(preview);
            assert.equal(service.getSourceSyncData(preview.index, preview.ratio)?.line, 5);
        }
    });

    test('maps AST wrapper hints through their original source spans', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider());
        const formula = '$O_P(\\sqrt{\\epsilon / n})$';
        const source = [
            '\\begin{document}',
            '\\begin{proof}',
            'Proof opening.',
            `Formula line has ${formula} in the middle.`,
            'Proof closing.',
            '\\end{proof}',
            '\\end{document}'
        ].join('\n');

        await service.render(uri, source, { deferFullHtml: true, backendMode: 'ast(experimental)' });
        await service.renderBlockByIndex(0);
        const preview = service.getPreviewSyncData(uri.toString(), 3, 'Formula line has $O_P(\\sqrt'.length);

        assert.ok(preview?.sourceStart !== undefined);
        assert.equal((preview.sourceEnd ?? 0) - preview.sourceStart, formula.length);
        assert.equal(
            service.getSourceSyncData(preview.index, preview.ratio, {
                anchors: ['Proof closing'],
                sourceStart: preview.sourceStart,
                sourceEnd: preview.sourceEnd
            })?.line,
            3
        );
        assert.equal(service.getSourceSyncData(preview.index, preview.ratio, { anchors: ['Formula line has'] })?.line, 3);

        const closingPreview = service.getPreviewSyncData(uri.toString(), 4, 0);
        assert.ok(closingPreview);
        assert.equal(service.getSourceSyncData(closingPreview.index, closingPreview.ratio)?.line, 4);
    });
});
