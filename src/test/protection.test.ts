/// <reference types="mocha" />

import * as assert from 'assert';
import { ProtectionManager } from '../protection';

suite('ProtectionManager', () => {
    test('resolves protected tokens and resets token state', () => {
        const protector = new ProtectionManager();
        const inner = protector.protect('inner', '<span>inner</span>');
        const outer = protector.protect('outer', `<div>${inner}</div>`);
        assert.equal(protector.resolve(`<p>${outer}</p>`), '<div><span>inner</span></div>');

        const token = protector.protect('style', '<span>inline</span>', 'inline');
        assert.equal(protector.resolve(`<p>${token}</p>`), '<p><span>inline</span></p>');

        const oldToken = protector.protect('x', '<b>x</b>');
        protector.reset();
        assert.equal(protector.resolve(oldToken), oldToken);
        assert.equal(protector.protect('x', '<b>new</b>'), 'XSNAP:x:0Y');
    });
});
