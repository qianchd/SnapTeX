/// <reference types="mocha" />

import * as assert from 'assert';
import { splitLatexWithAst, splitLatexWithAstIncremental } from '../ast/splitter';
import { SNAP_TEX_RULES } from '../rules';
import type { SplitterRule } from '../types';
import { spanText } from './test-helpers';

const SPLITTER_OPTIONS = {
    config: SNAP_TEX_RULES.splitterConfig,
    rules: SNAP_TEX_RULES.splitterRules
};
suite('AST splitter', () => {
    test('keeps text immediately following display math in the same block', async () => {
        const text = [
            'Before equation:',
            '\\begin{equation}\\label{eq:test}',
            'x=1',
            '\\end{equation}',
            'where the equation is explained.',
            '',
            'Next paragraph.'
        ].join('\n');
        const result = await splitLatexWithAst(text, SPLITTER_OPTIONS);
        const blocks = result.spans.map(span => spanText(text, span).trim()).filter(Boolean);

        assert.deepEqual(blocks, [
            'Before equation:',
            '\\begin{equation}\\label{eq:test}\nx=1\n\\end{equation}\nwhere the equation is explained.',
            'Next paragraph.'
        ]);
    });

    test('recurses into transparent environments and keeps nested split environments visible', async () => {
        const text = [
            '\\begin{appendices}',
            'Appendix intro.',
            '',
            '\\begin{table}',
            '\\caption{T}',
            '\\end{table}',
            '',
            'Appendix after.',
            '\\end{appendices}'
        ].join('\n');
        const result = await splitLatexWithAst(text, SPLITTER_OPTIONS);
        const blocks = result.spans.map(span => spanText(text, span).trim()).filter(Boolean);

        assert.ok(blocks.some(block => block.startsWith('\\begin{table}')));
        assert.ok(blocks.every(block => !block.includes('\\begin{appendices}') && !block.includes('\\end{appendices}')));
    });

    test('preserves context wrappers when splitting long color groups', async () => {
        const text = [
            'Lead {\\color{blue} first',
            '',
            'second',
            '',
            'third} tail'
        ].join('\n');
        const result = await splitLatexWithAst(text, SPLITTER_OPTIONS);
        const blocks = result.spans.map(span => spanText(text, span).trim()).filter(Boolean);

        assert.deepEqual(blocks, [
            'Lead {\\color{blue} first}',
            '{\\color{blue} second}',
            '{\\color{blue} third}',
            'tail'
        ]);
    });

    test('uses group and argument context wrappers for coarse protection and AST refinement', async () => {
        const wrapperRule: SplitterRule = {
            name: 'highlight-groups',
            kind: 'context-wrapper',
            macroPattern: /^highlight$/,
            content: 'group-remainder'
        };
        const text = [
            '{\\highlight',
            'first line',
            'continued',
            '',
            'second line',
            '}',
            '',
            '\\resizebox{\\linewidth}{!}{',
            'third line',
            '',
            'fourth line',
            '}'
        ].join('\n');
        const result = await splitLatexWithAst(text, {
            config: { maxBlockLines: 2, maxNoEmergencySplitLines: 20 },
            rules: [...SPLITTER_OPTIONS.rules, wrapperRule]
        });
        const blocks = result.spans.map(span => spanText(text, span).trim()).filter(Boolean);

        assert.equal(blocks.length, 4);
        assert.ok(blocks.slice(0, 2).every(block => block.startsWith('{\\highlight') && block.endsWith('}')));
        assert.match(blocks[0], /continued/);
        assert.match(blocks[1], /second line/);
        assert.ok(blocks.slice(2).every(block => block.startsWith('\\resizebox{\\linewidth}{!}{') && block.endsWith('}')));
        assert.match(blocks[2], /third line/);
        assert.match(blocks[3], /fourth line/);
    });

    test('incremental edits preserve full-split spans, line numbers and wrapper context', async () => {
        const original = '\\begin{appendices}\nIntro.\n\n{\\color{blue} First.\n\nSecond.}\n\n'
            + '\\begin{proof}\nProof text.\n\n\\begin{equation}x=1\\end{equation}\nwhere x is defined.\n\\end{proof}\n\n'
            + 'Last paragraph.\n\\end{appendices}';
        let previous = await splitLatexWithAst(original, SPLITTER_OPTIONS);
        for (const text of [
            original.replace('First.', 'First.\n\nInserted.'),
            original.replace('First.\n\n', ''),
            original.replace('blue', 'red').replace('Intro.', 'Changed intro.\nMore text.'),
            original.replace('\\end{proof}', ''),
            '', original
        ]) {
            const incremental = await splitLatexWithAstIncremental(text, SPLITTER_OPTIONS, previous);
            assert.deepStrictEqual(incremental, await splitLatexWithAst(text, SPLITTER_OPTIONS));
            for (const span of [...incremental.coarseSpans, ...incremental.spans]) {
                assert.equal(span.line, text.slice(0, span.start).split('\n').length - 1);
                assert.equal(span.lineCount, text.slice(span.start, span.end).split('\n').length);
            }
            previous = incremental;
        }
    });

});
