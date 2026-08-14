/// <reference types="mocha" />

import * as assert from 'assert';
import { splitLatexWithAst } from '../ast/splitter';
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

        assert.equal(result.parseOk, true);
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

});
