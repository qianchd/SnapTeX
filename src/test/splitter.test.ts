/// <reference types="mocha" />

import * as assert from 'assert';
import { SNAP_TEX_RULES } from '../rules';
import { LatexBlockSplitter } from '../splitter';
import { spanText } from './test-helpers';

const split = (text: string, registry = SNAP_TEX_RULES) => LatexBlockSplitter.split(text, {
    config: registry.splitterConfig,
    rules: registry.splitterRules
});
const blockTexts = (text: string, registry = SNAP_TEX_RULES) => split(text, registry).map(block => spanText(text, block));
const sparseLines = (count: number, prefix: string, blankEvery: number) => Array.from({ length: count }, (_unused, index) => (
    index % blankEvery === 0 ? '' : `${prefix} ${index}`
));
const singleBlockContaining = (text: string, marker: string, registry = SNAP_TEX_RULES) => {
    const blocks = blockTexts(text, registry).filter(block => block.includes(marker));
    assert.equal(blocks.length, 1);
    return blocks[0];
};

suite('LatexBlockSplitter', () => {
    test('splits before split environments but keeps starred floats intact', () => {
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

        const texts = blockTexts(text);

        assert.equal(texts.length, 3);
        assert.equal(texts[0].trim(), 'Before figure.');
        assert.match(texts[1], /\\begin\{figure\*\}/);
        assert.match(texts[1], /\\includegraphics\{wide\.pdf\}/);
        assert.match(texts[1], /\\end\{figure\*\}/);
        assert.equal(texts[2].trim(), 'After figure.');
    });

    test('does not emergency-split long protected environments', () => {
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

        const texts = blockTexts(text);
        const tikzBlocks = texts.filter(block => /tikzpicture/.test(block));

        assert.equal(tikzBlocks.length, 1);
        assert.match(tikzBlocks[0], /\\begin\{figure\}/);
        assert.match(tikzBlocks[0], /\\begin\{tikzpicture\}/);
        assert.match(tikzBlocks[0], /\\end\{tikzpicture\}/);
        assert.match(tikzBlocks[0], /\\end\{figure\}/);
        assert.match(texts.join('\n'), /After\./);

        const items = Array.from({ length: 45 }, (_unused, index) => [
            `\\bibitem{K${index}}`,
            `Author ${index}. (2020). Title ${index}.`
        ].join('\n'));
        const bibliographyText = [
            'Before.',
            '',
            '\\begin{thebibliography}{99}',
            ...items.flatMap(item => [item, '']),
            '\\end{thebibliography}',
            '',
            'After.'
        ].join('\n');

        const bibliographyBlock = singleBlockContaining(bibliographyText, 'thebibliography');

        assert.match(bibliographyBlock, /\\bibitem\{K0\}/);
        assert.match(bibliographyBlock, /\\bibitem\{K44\}/);
        assert.match(bibliographyBlock, /\\end\{thebibliography\}/);
    });

    test('does not emergency-split long color groups', () => {
        const lines = sparseLines(55, 'blue line', 5);
        const text = [
            'Before.',
            '',
            '{\\color{blue}',
            ...lines,
            '}',
            '',
            'After.'
        ].join('\n');

        const colorBlock = singleBlockContaining(text, '\\color{blue}');

        assert.match(colorBlock, /blue line 54/);
        assert.match(colorBlock, /\}\s*$/);
    });

});
