/// <reference types="mocha" />

import * as assert from 'assert';
import { LatexCounterScanner } from '../scanner';
import { createBlockTextProvider, scanBlocks } from './test-helpers';

suite('LatexCounterScanner', () => {
    test('numbers regular and starred floats consistently', () => {
        const blocks = [
            '\\begin{figure}\\caption{A}\\label{fig:a}\\end{figure}',
            '\\begin{figure*}\\caption{B}\\label{fig:b}\\end{figure*}',
            '\\begin{table*}\\caption{T}\\label{tbl:t}\\end{table*}',
            '\\begin{algorithm*}\\caption{Alg}\\label{alg:a}\\end{algorithm*}'
        ];

        const result = scanBlocks(blocks);

        assert.deepStrictEqual(result.blockNumbering[0].counts.fig, ['1']);
        assert.deepStrictEqual(result.blockNumbering[1].counts.fig, ['2']);
        assert.deepStrictEqual(result.blockNumbering[2].counts.tbl, ['1']);
        assert.deepStrictEqual(result.blockNumbering[3].counts.alg, ['1']);
        assert.equal(result.labelMap['fig:a'], '1');
        assert.equal(result.labelMap['fig:b'], '2');
        assert.equal(result.labelMap['tbl:t'], '1');
        assert.equal(result.labelMap['alg:a'], '1');
    });

    test('numbers sections and skips starred equations', () => {
        const blocks = [
            '\\section{Intro}\\label{sec:intro}',
            '\\subsection{Setup}',
            '\\begin{equation}x=1\\label {eq:x}\\end{equation}',
            '\\begin{equation*}y=1\\label{eq:y}\\end{equation*}'
        ];

        const result = scanBlocks(blocks);

        assert.deepStrictEqual(result.blockNumbering[0].counts.sec, ['1']);
        assert.deepStrictEqual(result.blockNumbering[1].counts.sec, ['1.1']);
        assert.deepStrictEqual(result.blockNumbering[2].counts.eq, ['1']);
        assert.deepStrictEqual(result.blockNumbering[3].counts.eq, []);
        assert.equal(result.labelMap['sec:intro'], '1');
        assert.equal(result.labelMap['eq:x'], '1');
        assert.equal(result.labelMap['eq:y'], undefined);
    });

    test('uses explicit equation tags as lightweight display numbers', () => {
        const result = scanBlocks([
            '\\begin{equation}x=1\\tag{A}\\label{eq:tagged}\\end{equation}',
            '\\begin{equation}y=1\\label{eq:next}\\end{equation}'
        ]);

        assert.deepStrictEqual(result.blockNumbering[0].counts.eq, ['A']);
        assert.deepStrictEqual(result.blockNumbering[1].counts.eq, ['2']);
        assert.equal(result.labelMap['eq:tagged'], 'A');
        assert.equal(result.labelMap['eq:next'], '2');
    });

    test('reuses unchanged block summaries while updating numbering offsets', () => {
        const scanner = new LatexCounterScanner();
        const firstReads: number[] = [];
        scanner.scan(createBlockTextProvider([
            '\\begin{equation}\\label{eq:a}a=1\\end{equation}',
            '\\begin{equation}\\label{eq:b}b=1\\end{equation}',
            '\\begin{equation}\\label{eq:c}c=1\\end{equation}'
        ], firstReads));

        const secondReads: number[] = [];
        const result = scanner.scan(createBlockTextProvider([
            '\\begin{equation}\\label{eq:a}a=1\\end{equation}',
            [
                '\\begin{equation}\\label{eq:b}b=1\\end{equation}',
                '\\begin{equation}\\label{eq:new}n=1\\end{equation}'
            ].join('\n'),
            '\\begin{equation}\\label{eq:c}c=1\\end{equation}'
        ], secondReads));

        assert.deepStrictEqual(firstReads, [0, 1, 2]);
        assert.deepStrictEqual(secondReads, [1]);
        assert.equal(result.labelMap['eq:a'], '1');
        assert.equal(result.labelMap['eq:b'], '2');
        assert.equal(result.labelMap['eq:new'], '3');
        assert.equal(result.labelMap['eq:c'], '4');
    });
});
