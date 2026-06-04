/// <reference types="mocha" />

import * as assert from 'assert';
import { ProtectionManager } from '../protection';

suite('ProtectionManager', () => {
    test('resolves bare, paragraph-wrapped, and nested tokens', () => {
        const protector = new ProtectionManager();
        const inner = protector.protect('inner', '<span>inner</span>');
        const outer = protector.protect('outer', `<div>${inner}</div>`);

        assert.equal(protector.resolve(`<p>${outer}</p>`), '<div><span>inner</span></div>');
    });

    test('reset clears old tokens and restarts ids', () => {
        const protector = new ProtectionManager();
        const token = protector.protect('x', '<b>x</b>');
        protector.reset();

        assert.equal(protector.resolve(token), token);
        assert.equal(protector.protect('x', '<b>new</b>'), 'XSNAP:x:0Y');
    });
});
