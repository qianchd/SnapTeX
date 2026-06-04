/// <reference types="mocha" />

import * as assert from 'assert';
import { extractMetadata } from '../metadata';

suite('Metadata extraction', () => {
    test('extracts metadata, macros, TikZ globals, and TikZ macros', () => {
        const result = extractMetadata([
            '\\title{A \\\\ Title}',
            '\\author{Ada}',
            '\\date{\\today}',
            '\\newcommand{\\vect}[1]{\\mathbf{#1}}',
            '\\renewcommand{\\oldmacro}{\\mathrm{o}}',
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
        assert.equal(result.data.macros['\\oldmacro'], '\\mathrm{o}');
        assert.equal(result.data.macros['\\rank'], '\\operatorname{rank}');
        assert.match(result.data.tikzGlobal, /\\usetikzlibrary\{arrows\.meta\}/);
        assert.match(result.data.tikzGlobal, /\\tikzset\{box\/.style=\{draw\}\}/);
        assert.equal(result.data.tikzMacroMap.get('\\origin'), '\\def\\origin{(0,0)}');
        assert.equal(result.data.tikzMacroMap.get('\\vect'), '\\def\\vect#1{\\mathbf{#1}}');
        assert.equal(result.data.tikzMacroMap.get('\\oldmacro'), '\\def\\oldmacro{\\mathrm{o}}');
        assert.doesNotMatch(result.cleanedText, /\\title/);
        assert.doesNotMatch(result.cleanedText, /\\author/);
        assert.doesNotMatch(result.cleanedText, /\\newcommand\{\\vect\}/);
        assert.doesNotMatch(result.cleanedText, /\\usetikzlibrary/);
    });
});
