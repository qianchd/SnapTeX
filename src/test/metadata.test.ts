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
            '\\renewcommand{\\oldmacro}{\\mathrm{o}}',
            '\\gdef\\globalmacro#1{\\mathcal{#1}}',
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

        assert.equal(result.data.title, 'A \\\\ Title');
        assert.equal(result.data.authors[0].name, 'Ada');
        assert.ok(result.data.date);
        assert.equal(result.data.macros['\\vect'], '\\mathbf{#1}');
        assert.equal(result.data.macros['\\oldmacro'], '\\mathrm{o}');
        assert.equal(result.data.macros['\\globalmacro'], '\\mathcal{#1}');
        assert.equal(result.data.macros['\\rank'], '\\operatorname{rank}');
        assert.match(result.data.tikzGlobal, /\\usetikzlibrary\{arrows\.meta\}/);
        assert.match(result.data.tikzGlobal, /\\tikzset\{box\/.style=\{draw\}\}/);
        assert.equal(result.data.tikzMacroMap.get('\\origin'), '\\def\\origin{(0,0)}');
        assert.equal(result.data.tikzMacroMap.get('\\vect'), '\\def\\vect#1{\\mathbf{#1}}');
        assert.equal(result.data.tikzMacroMap.get('\\oldmacro'), '\\def\\oldmacro{\\mathrm{o}}');
        assert.equal(result.data.tikzMacroMap.get('\\globalmacro'), '\\gdef\\globalmacro#1{\\mathcal{#1}}');
        assert.doesNotMatch(result.cleanedText, /\\title/);
        assert.doesNotMatch(result.cleanedText, /\\author/);
        assert.doesNotMatch(result.cleanedText, /\\newcommand\{\\vect\}/);
        assert.doesNotMatch(result.cleanedText, /\\usetikzlibrary/);
    });

    test('keeps plain author blocks as one author entry', () => {
        const result = extract([
            '\\author{Alice Smith\\\\University A\\\\\\texttt{alice@a.edu}\\and Bob Jones\\\\University B}',
            '\\begin{document}',
            '\\maketitle',
            '\\end{document}'
        ].join('\n'));

        assert.equal(result.data.authors.length, 1);
        assert.match(result.data.authors[0].name, /Alice Smith/);
        assert.deepStrictEqual(result.data.authors[0].emails, []);
        assert.deepStrictEqual(result.data.affiliations, []);
    });

    test('extracts repeated author email affiliation commands', () => {
        const result = extract([
            '\\author{Alice}',
            '\\email{alice@a.edu}',
            '\\affiliation{University A}',
            '\\author{Bob}',
            '\\email{bob@a.edu}',
            '\\affiliation{University A}'
        ].join('\n'));

        assert.deepStrictEqual(result.data.authors.map(author => author.name), ['Alice', 'Bob']);
        assert.deepStrictEqual(result.data.authors.map(author => author.emails), [['alice@a.edu'], ['bob@a.edu']]);
        assert.equal(result.data.affiliations.length, 1);
        assert.deepStrictEqual(result.data.authors.map(author => author.affiliationIds), [['1'], ['1']]);
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

    test('extracts authblk shared affiliations', () => {
        const result = extract([
            '\\author[1]{Alice}',
            '\\author[1]{Bob}',
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
    });

    test('extracts authblk emails from grouped email commands', () => {
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

    test('extracts inst and institute metadata', () => {
        const result = extract([
            '\\author{Alice\\inst{1} \\and Bob\\inst{1} \\and Carol\\inst{2}}',
            '\\institute{University A\\\\\\email{alice@a.edu, bob@a.edu}\\and University B\\\\\\email{carol@b.edu}}'
        ].join('\n'));

        assert.deepStrictEqual(result.data.authors.map(author => author.name), ['Alice', 'Bob', 'Carol']);
        assert.deepStrictEqual(result.data.authors.map(author => author.affiliationIds), [['1'], ['1'], ['2']]);
        assert.deepStrictEqual(result.data.authors.map(author => author.emails), [['alice@a.edu', 'bob@a.edu'], ['alice@a.edu', 'bob@a.edu'], ['carol@b.edu']]);
        assert.deepStrictEqual(result.data.affiliations.map(affiliation => affiliation.text), ['University A', 'University B']);
    });

    test('extracts ACM and Elsevier affiliation forms', () => {
        const acm = extract([
            '\\author{Alice}',
            '\\email{alice@a.edu}',
            '\\affiliation{\\institution{University A}\\city{Town}\\country{USA}}'
        ].join('\n'));
        assert.deepStrictEqual(acm.data.authors[0].emails, ['alice@a.edu']);
        assert.equal(acm.data.affiliations[0].text, 'University A, Town, USA');

        const elsevier = extract([
            '\\author[inst1]{Bob}',
            '\\ead{bob@b.edu}',
            '\\affiliation[inst1]{organization={University B}, city={City}, country={UK}}'
        ].join('\n'));
        assert.deepStrictEqual(elsevier.data.authors[0].affiliationIds, ['inst1']);
        assert.deepStrictEqual(elsevier.data.authors[0].emails, ['bob@b.edu']);
        assert.equal(elsevier.data.affiliations[0].text, 'University B, City, UK');
    });

    test('extracts IEEE author blocks', () => {
        const result = extract([
            '\\IEEEauthorblockN{Alice Smith, Bob Jones}',
            '\\IEEEauthorblockA{University A\\\\Email: alice@a.edu}'
        ].join('\n'));

        assert.deepStrictEqual(result.data.authors.map(author => author.name), ['Alice Smith', 'Bob Jones']);
        assert.deepStrictEqual(result.data.authors.map(author => author.affiliationIds), [['1'], ['1']]);
        assert.deepStrictEqual(result.data.authors.map(author => author.emails), [['alice@a.edu'], ['alice@a.edu']]);
        assert.equal(result.data.affiliations[0].text, 'University A');
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

    test('does not let empty extractor arrays clear title-page metadata', () => {
        const result = extractMetadata('\\author[1]{Ada}\\affil[1]{University A}\\keywords{alpha}', [
            ...SNAP_TEX_RULES.metadataExtractors,
            {
                name: 'empty-custom',
                extract: () => ({ authors: [], affiliations: [], keywords: [] })
            }
        ]);

        assert.deepStrictEqual(result.data.authors.map(author => author.name), ['Ada']);
        assert.deepStrictEqual(result.data.affiliations, [{ id: '1', text: 'University A' }]);
        assert.deepStrictEqual(result.data.keywords, ['alpha']);
    });
});
