/// <reference types="mocha" />

import * as assert from 'assert';
import * as vscode from 'vscode';
import { PreviewUpdateService } from '../preview-update-service';
import { SmartRenderer } from '../renderer';
import { MemoryFileProvider } from './test-helpers';

suite('PreviewUpdateService', () => {
    const uri = vscode.Uri.file('/project/main.tex');
    const text = [
        '\\begin{document}',
        'First paragraph.',
        '',
        'Second paragraph.',
        '\\end{document}'
    ].join('\n');

    test('renders and transforms eager HTML payloads', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider(), new SmartRenderer());

        const payload = await service.render(uri, text, {
            deferFullHtml: false,
            transformHtml: html => html.replace('First paragraph.', 'Transformed paragraph.')
        });

        assert.match(payload.htmls?.join('\n') ?? '', /Transformed paragraph/);
    });

    test('keeps lazy block rendering available after deferred payloads', async () => {
        const service = new PreviewUpdateService(new MemoryFileProvider(), new SmartRenderer());

        const payload = await service.render(uri, text, { deferFullHtml: true });
        const firstBlock = service.renderBlockByIndex(0);

        assert.ok(payload.blocks);
        assert.match(firstBlock?.html ?? '', /First paragraph/);
    });
});
