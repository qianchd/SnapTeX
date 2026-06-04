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
    });

    test('compares hashes instead of raw payload fields', () => {
        const oldBlocks = [{ hash: 'same', text: 'old text' }];
        const newBlocks = [{ hash: 'same', text: 'new text' }];

        assert.deepStrictEqual(
            DiffEngine.compute(oldBlocks, newBlocks),
            {
                start: 1,
                deleteCount: 0,
                end: 0,
                insertCount: 0
            }
        );
    });
});
