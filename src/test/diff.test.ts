/// <reference types="mocha" />

import * as assert from 'assert';
import { DiffEngine } from '../diff';

suite('DiffEngine', () => {
    test('computes unchanged, insert, delete, and replace spans', () => {
        const h = (...hashes: string[]) => hashes.map((hash, index) => ({ hash, payload: `payload-${index}` }));

        assert.deepStrictEqual(DiffEngine.compute(h('a', 'b'), h('a', 'b')), {
            start: 2,
            deleteCount: 0,
            end: 0,
            insertCount: 0
        });

        assert.deepStrictEqual(DiffEngine.compute(h('a', 'c'), h('a', 'b', 'c')), {
            start: 1,
            deleteCount: 0,
            end: 1,
            insertCount: 1
        });

        assert.deepStrictEqual(DiffEngine.compute(h('a', 'b', 'c'), h('a', 'c')), {
            start: 1,
            deleteCount: 1,
            end: 1,
            insertCount: 0
        });

        assert.deepStrictEqual(DiffEngine.compute(h('a', 'old', 'c'), h('a', 'new', 'c')), {
            start: 1,
            deleteCount: 1,
            end: 1,
            insertCount: 1
        });

        const oldBlocks = [{ hash: 'same', payload: 'old text' }];
        const newBlocks = [{ hash: 'same', payload: 'new text' }];
        assert.deepStrictEqual(DiffEngine.compute(oldBlocks, newBlocks), {
            start: 1,
            deleteCount: 0,
            end: 0,
            insertCount: 0
        });
    });

    test('rebuilds arrays by reusing unchanged prefix and suffix items', () => {
        const oldItems = ['old-a', 'old-b', 'old-c'];
        const diff = { start: 1, deleteCount: 1, end: 1, insertCount: 2 };

        const rebuilt = DiffEngine.rebuildArray(
            oldItems,
            4,
            diff,
            index => `new-${index}`,
            (item, index) => `${item}@${index}`
        );

        assert.deepStrictEqual(rebuilt, ['old-a@0', 'new-1', 'new-2', 'old-c@3']);
    });
});
