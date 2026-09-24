/// <reference types="mocha" />

import * as assert from 'assert';
import { extractMetadata } from '../metadata';
import { SNAP_TEX_RULES } from '../rules';

const extract = (source: string) => extractMetadata(source, SNAP_TEX_RULES.metadataExtractors);

suite('Metadata extraction', () => {
    test('extracts metadata, macros, TikZ globals, and TikZ macros', () => {
        const result = extract([
            '\\title{A \\\\ Title}',
            '\\author{Ada}',
            '\\date{\\today}',
            '\\newcommand{\\vect}[1]{\\mathbf{#1}}',
            '\\newcommand{\\expectation}[2][P]{\\mathbb{E}_{#1}[#2]}',
            '\\providecommand{\\provided}[1]{\\mathsf{#1}}',
            '\\algnewcommand\\Output{\\textbf{Output:}}',
            '\\renewcommand{\\oldmacro}{\\mathrm{o}}',
            '\\gdef\\globalmacro#1{\\mathcal{#1}}',
            '\\DeclareMathOperator{\\rank}{rank}',
            '\\DeclarePairedDelimiter{\\abs}{\\lvert}{\\rvert}',
            '\\DeclarePairedDelimiterX{\\inner}[2]{\\langle}{\\rangle}{#1,#2}',
            '\\let\\epsilon=\\varepsilon',
            '\\newtheorem{assumptionB}{B.}',
            '\\newenvironment{enumalpha}{\\begin{enumerate}[label=(\\alph*)]}{\\end{enumerate}}',
            '\\newenvironment{revision}{}{}',
            '\\newenvironment{reviewtext}{\\color{blue}\\ignorespaces}{\\ignorespacesafterend}',
            '\\newenvironment{remarks}{\\noindent\\textbf{Remarks.}\\begin{itemize}}{\\end{itemize}\\par}',
            '\\newtcolorbox{boxednote}{colback=blue!5}',
            '\\definecolor{brandHtml}{HTML}{7A3DF0}',
            '\\definecolor{brandRgb}{RGB}{12,34,56}',
            '\\definecolor{brandUnit}{rgb}{0.1,0.2,0.3}',
            '\\definecolor{brandNamed}{named}{purple}',
            '\\definecolor{brandGray}{gray}{0.5}',
            '\\definecolor{brandCmyk}{cmyk}{0,1,1,0}',
            '\\usetikzlibrary{arrows.meta}',
            '\\tikzset{box/.style={draw}}',
            '\\pgfkeys{/pgf/custom offset/.initial=2mm}',
            '\\pgfdeclareshape{custom shape}{\\inheritanchor[from=rectangle]{center}}',
            '\\newcommand{\\origin}{(0,0)}',
            '\\begin{document}',
            '\\maketitle',
            '$\\vect{x}$',
            '\\begin{tikzpicture}\\draw \\origin -- (1,1);\\end{tikzpicture}',
            '\\end{document}'
        ].join('\n'));

        assert.equal(result.data.title, 'A \\\\ Title');
        assert.equal(result.data.authors[0].name, 'Ada');
        assert.ok(result.data.date);
        assert.deepStrictEqual(result.data.macros['\\vect'], { body: '\\mathbf{#1}', argumentCount: 1 });
        assert.deepStrictEqual(result.data.macros['\\expectation'], {
            body: '\\mathbb{E}_{#1}[#2]',
            argumentCount: 2,
            defaultArgument: 'P'
        });
        assert.deepStrictEqual(result.data.macros['\\provided'], { body: '\\mathsf{#1}', argumentCount: 1 });
        assert.deepStrictEqual(result.data.macros['\\Output'], { body: '\\textbf{Output:}', argumentCount: 0 });
        assert.deepStrictEqual(result.data.macros['\\oldmacro'], { body: '\\mathrm{o}', argumentCount: 0 });
        assert.deepStrictEqual(result.data.macros['\\globalmacro'], { body: '\\mathcal{#1}', argumentCount: 1 });
        assert.deepStrictEqual(result.data.macros['\\rank'], { body: '\\operatorname{rank}', argumentCount: 0 });
        assert.deepStrictEqual(result.data.macros['\\abs'], {
            body: '\\left\\lvert#1\\right\\rvert', argumentCount: 1, allowStar: true
        });
        assert.deepStrictEqual(result.data.macros['\\inner'], {
            body: '\\left\\langle#1,#2\\right\\rangle', argumentCount: 2, allowStar: true
        });
        assert.deepStrictEqual(result.data.environments, {
            assumptionB: { kind: 'theorem', displayName: 'B.', numbered: true },
            enumalpha: { kind: 'alias', target: 'enumerate', options: 'label=(\\alph*)' },
            revision: { kind: 'transparent' },
            reviewtext: { kind: 'style', declaration: '\\color{blue}' },
            remarks: {
                kind: 'alias',
                target: 'itemize',
                opening: '\\noindent\\textbf{Remarks.}\\begin{itemize}',
                closing: '\\end{itemize}\\par'
            },
            boxednote: { kind: 'transparent' }
        });
        assert.deepStrictEqual(result.data.colors, {
            brandHtml: '#7A3DF0',
            brandRgb: 'rgb(12 34 56)',
            brandUnit: 'rgb(26 51 77)',
            brandNamed: 'purple',
            brandGray: 'rgb(128 128 128)',
            brandCmyk: 'rgb(255 0 0)'
        });
        assert.match(result.data.tikzGlobal, /\\usetikzlibrary\{arrows\.meta\}/);
        assert.match(result.data.tikzGlobal, /\\tikzset\{box\/.style=\{draw\}\}/);
        assert.match(result.data.tikzGlobal, /\\pgfkeys\{\/pgf\/custom offset/);
        assert.match(result.data.tikzGlobal, /\\pgfdeclareshape\{custom shape\}/);
        assert.equal(result.data.tikzMacroMap.get('\\origin'), '\\def\\origin{(0,0)}');
        assert.equal(result.data.tikzMacroMap.get('\\vect'), '\\def\\vect#1{\\mathbf{#1}}');
        assert.equal(result.data.tikzMacroMap.get('\\oldmacro'), '\\def\\oldmacro{\\mathrm{o}}');
        assert.equal(result.data.tikzMacroMap.get('\\globalmacro'), '\\gdef\\globalmacro#1{\\mathcal{#1}}');
        assert.equal(result.data.tikzMacroMap.get('\\abs'), '\\def\\abs#1{\\left\\lvert#1\\right\\rvert}');
        assert.doesNotMatch(result.cleanedText, /\\title/);
        assert.doesNotMatch(result.cleanedText, /\\author/);
        assert.doesNotMatch(result.cleanedText, /\\newcommand\{\\vect\}/);
        assert.doesNotMatch(result.cleanedText, /\\(?:new(?:theorem|environment|tcolorbox)|providecommand|algnewcommand)/);
        assert.doesNotMatch(result.cleanedText, /\\let\\epsilon/);
        assert.doesNotMatch(result.cleanedText, /\\definecolor/);
        assert.doesNotMatch(result.cleanedText, /\\usetikzlibrary/);
    });

    test('masks comments in extracted TikZ globals without creating TeX paragraphs', () => {
        const result = extract([
            '\\tikzset{',
            '  dot/.style={circle},',
            '  % comment inside pgfkeys',
            '  pics/right angle/.append style={',
            '    /tikz/draw',
            '  }',
            '}'
        ].join('\n'));

        assert.match(result.data.tikzGlobal, /\n\s*%\n\s*pics\/right angle/);
        assert.doesNotMatch(result.data.tikzGlobal, /\n\s*\n\s*pics\/right angle/);
    });

    test('masks false conditional branches while preserving source positions', () => {
        const source = [
            'before 😊',
            '\\iffalse',
            '\\newcommand{\\hidden}{hidden}',
            '\\iffalse nested \\else still hidden \\fi',
            '\\else',
            'visible fallback',
            '\\fi',
            '\\iffalse unterminated',
            'after'
        ].join('\n');
        const result = extract(source);

        assert.equal(result.cleanedText.length, source.length);
        assert.equal(result.cleanedText.split('\n').length, source.split('\n').length);
        assert.doesNotMatch(result.cleanedText, /hidden|still hidden/);
        assert.match(result.cleanedText, /visible fallback/);
        assert.match(result.cleanedText, /\\iffalse unterminated/);
        assert.equal(result.data.macros['\\hidden'], undefined);
    });

    test('extracts journal-style author address groups', () => {
        const result = extract([
            '\\AuthorMark{Alice Stone, Brian Vale, and Cara Reed}',
            '\\TitleMark{Sparse Canonical Analysis for Synthetic Models}',
            '\\title{Sparse Canonical Analysis for Synthetic Models\\footnote{Funding note}}',
            String.raw`\author{Alice \uppercase{Stone}}             %%%  1st Author information  %%%
    {Address\\Department of Mathematics, Example North University, North City, Exampleland
    E-mail\,$:alice.stone@example.edu$ }`,
            String.raw`\author{Brian \uppercase{Vale}}{Address\\Institute of Applied Finance, Example River College, River City, Exampleland E-mail\,$:brian.vale@example.edu$ }`,
            String.raw`\author{Cara \uppercase{Reed}}{Address\\School of Data Science, Example South Institute, South City, Exampleland\\ E-mail\,$:cara.reed@example.edu$ }`
        ].join('\n'));

        assert.deepStrictEqual(result.data.authors.map(author => author.name), ['Alice STONE', 'Brian VALE', 'Cara REED']);
        assert.deepStrictEqual(result.data.authors.map(author => author.emails), [['alice.stone@example.edu'], ['brian.vale@example.edu'], ['cara.reed@example.edu']]);
        assert.deepStrictEqual(result.data.authors.map(author => author.affiliationIds), [['1'], ['2'], ['3']]);
        assert.deepStrictEqual(result.data.affiliations.map(affiliation => affiliation.text), [
            'Department of Mathematics, Example North University, North City, Exampleland',
            'Institute of Applied Finance, Example River College, River City, Exampleland',
            'School of Data Science, Example South Institute, South City, Exampleland'
        ]);
        assert.equal(result.data.custom.authorMark, 'Alice Stone, Brian Vale, and Cara Reed');
        assert.equal(result.data.custom.titleMark, 'Sparse Canonical Analysis for Synthetic Models');
        assert.doesNotMatch(result.cleanedText, /\\AuthorMark/);
        assert.doesNotMatch(result.cleanedText, /\\TitleMark/);
        assert.doesNotMatch(result.cleanedText, /alice\.stone@example\.edu/);
    });

    test('extracts authblk shared affiliations and grouped emails', () => {
        const result = extract([
            '\\author[1]{Alice}',
            '\\author*[1]{Bob}',
            '\\author[2]{Carol}',
            '\\affil[1]{University A}',
            '\\affil[2]{University B}'
        ].join('\n'));

        assert.deepStrictEqual(result.data.authors.map(author => author.name), ['Alice', 'Bob', 'Carol']);
        assert.deepStrictEqual(result.data.authors.map(author => author.affiliationIds), [['1'], ['1'], ['2']]);
        assert.deepStrictEqual(result.data.affiliations, [
            { id: '1', text: 'University A' },
            { id: '2', text: 'University B' }
        ]);

        const groupedEmail = extract([
            '\\author[1]{Alice Smith}',
            '\\author[2]{Bob Jones}',
            '\\author[3]{Carol Lee}',
            '\\email{alice@a.edu, bob@b.edu, carol@c.edu}',
            '\\affil[1]{University A}',
            '\\affil[2]{University B}',
            '\\affil[3]{Institute C}'
        ].join('\n'));

        assert.deepStrictEqual(groupedEmail.data.authors.map(author => author.emails), [['alice@a.edu'], ['bob@b.edu'], ['carol@c.edu']]);

        const journalAddress = extract([
            '\\author{Alice Smith}',
            '\\address{University A}',
            '\\email{alice@a.edu}'
        ].join('\n'));

        assert.deepStrictEqual(journalAddress.data.authors, [{
            name: 'Alice Smith',
            emails: ['alice@a.edu'],
            affiliationIds: ['1']
        }]);
        assert.deepStrictEqual(journalAddress.data.affiliations, [{ id: '1', text: 'University A' }]);
        assert.doesNotMatch(journalAddress.cleanedText, /\\address/);

        const affilText = extract([
            String.raw`\author[1]{Alice Smith}`,
            String.raw`\author[2]{Bob Jones}`,
            String.raw`\author[3]{Carol Lee}`,
            String.raw`\affil[1]{University A\\\texttt{alice@a.edu}}`,
            String.raw`\affil[2]{University B\\\texttt{bob@b.edu}}`,
            String.raw`\affil[3]{Institute C\\\texttt{carol@c.edu}}`
        ].join('\n'));

        assert.deepStrictEqual(affilText.data.authors.map(author => author.emails), [[], [], []]);
        assert.deepStrictEqual(affilText.data.affiliations.map(affiliation => affiliation.text), [
            String.raw`University A\\\texttt{alice@a.edu}`,
            String.raw`University B\\\texttt{bob@b.edu}`,
            String.raw`Institute C\\\texttt{carol@c.edu}`
        ]);
    });

    test('extracts custom metadata through registry extractors', () => {
        const result = extract([
            '\\title{A Title}',
            '\\editor{Prof. Smith}',
            '\\begin{document}',
            '\\maketitle',
            '\\end{document}'
        ].join('\n'));

        assert.equal(result.data.title, 'A Title');
        assert.equal(result.data.custom.editor, 'Prof. Smith');
        assert.doesNotMatch(result.cleanedText, /\\editor/);
    });

});
