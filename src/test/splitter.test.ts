/// <reference types="mocha" />

import * as assert from 'assert';
import { LatexBlockSplitter } from '../splitter';
import { spanText } from './test-helpers';

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
        const block = spanText(text, blocks[0]);

        assert.equal(blocks.length, 1);
        assert.match(block, /\\begin\{tikzpicture\}/);
        assert.match(block, /\\node \{A\};/);
        assert.match(block, /\\end\{tikzpicture\}/);
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
        const texts = blocks.map(block => spanText(text, block));

        assert.equal(blocks.length, 3);
        assert.equal(texts[0].trim(), 'Before figure.');
        assert.match(texts[1], /\\begin\{figure\*\}/);
        assert.match(texts[1], /\\includegraphics\{wide\.pdf\}/);
        assert.match(texts[1], /\\end\{figure\*\}/);
        assert.equal(texts[2].trim(), 'After figure.');
    });

    test('does not emergency-split long closed TikZ figures with internal blank lines', () => {
        const tikzBody = Array.from({ length: 65 }, (_, index) => (
            index % 8 === 0
                ? ''
                : `\\node at (${index}, 0) {Point ${index}};`
        ));
        const text = [
            'Before.',
            '',
            '\\begin{figure}[t]',
            '\\centering',
            '\\resizebox{\\linewidth}{!}{%',
            '\\begin{tikzpicture}[>=Latex]',
            ...tikzBody,
            '\\end{tikzpicture}',
            '}',
            '\\label{fig:long-tikz}',
            '\\end{figure}',
            '',
            'After.'
        ].join('\n');

        const blocks = LatexBlockSplitter.split(text);
        const texts = blocks.map(block => spanText(text, block));
        const tikzBlocks = texts.filter(block => /tikzpicture/.test(block));

        assert.equal(tikzBlocks.length, 1);
        assert.match(tikzBlocks[0], /\\begin\{figure\}/);
        assert.match(tikzBlocks[0], /\\begin\{tikzpicture\}/);
        assert.match(tikzBlocks[0], /\\end\{tikzpicture\}/);
        assert.match(tikzBlocks[0], /\\end\{figure\}/);
        assert.match(texts.join('\n'), /After\./);
    });
});
