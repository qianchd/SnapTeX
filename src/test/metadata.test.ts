/// <reference types="mocha" />

import * as assert from 'assert';
import { extractMetadata } from '../metadata';
import { SNAP_TEX_RULES } from '../rules';

suite('Metadata extraction', () => {
    test('extracts metadata, macros, TikZ globals, and TikZ macros', () => {
        const result = extractMetadata([
            '\\title{A \\\\ Title}',
            '\\author{Ada}',
            '\\date{\\today}',
            '\\institute{Example University}',
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
        ].join('\n'), SNAP_TEX_RULES.metadataFields);

        assert.equal(result.data.fields.title, 'A \\\\ Title');
        assert.equal(result.data.fields.author, 'Ada');
        assert.ok(result.data.fields.date);
        assert.equal(result.data.fields.institute, undefined);
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
        assert.match(result.cleanedText, /\\institute/);
        assert.doesNotMatch(result.cleanedText, /\\newcommand\{\\vect\}/);
        assert.doesNotMatch(result.cleanedText, /\\usetikzlibrary/);
    });

    test('extracts registry-provided metadata fields', () => {
        const result = extractMetadata([
            '\\title{A Title}',
            '\\institute{Example University}',
            '\\begin{document}',
            '\\maketitle',
            '\\end{document}'
        ].join('\n'), ['title', 'institute']);

        assert.equal(result.data.fields.title, 'A Title');
        assert.equal(result.data.fields.institute, 'Example University');
        assert.doesNotMatch(result.cleanedText, /\\institute/);
    });
});
