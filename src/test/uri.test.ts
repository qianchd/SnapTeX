/// <reference types="mocha" />

import * as assert from 'assert';
import * as vscode from 'vscode';
import { normalizeUri } from '../utils';

suite('URI normalization', () => {
    test('lowercases Windows file uris for stable comparisons', () => {
        const uri = vscode.Uri.file('C:/Project/Section.tex');
        assert.equal(normalizeUri(uri), '/c:/project/section.tex');
    });

    test('preserves case for remote uris', () => {
        const uri = vscode.Uri.parse('vscode-remote://ssh-remote+Host/home/User/Section.tex');
        assert.equal(normalizeUri(uri), 'vscode-remote://ssh-remote+host/home/User/Section.tex');
        assert.equal(
            normalizeUri('vscode-remote://ssh-remote+Host/home/User/Section.tex'),
            'vscode-remote://ssh-remote+Host/home/User/Section.tex'
        );
    });
});
