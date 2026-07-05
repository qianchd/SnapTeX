/// <reference types="mocha" />

import * as assert from 'assert';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { snaptexLatexCompletionSource } from '../../apps/standalone/src/editor-assistance';

const source = snaptexLatexCompletionSource(() => ({
    labels: ['eq:main', 'fig:demo'],
    citationKeys: ['greenwade93', 'knuth84'],
    projectPaths: ['/main.tex', '/sections/method.tex', '/figures/pipeline.png', '/figures/diagram.pdf'],
    macros: ['\\hf', 'customMacro']
}));

function completions(doc: string) {
    const state = EditorState.create({ doc });
    const result = source(new CompletionContext(state, doc.length, true));
    assert.ok(result);
    return result.options.map(option => option.label);
}

suite('CodeMirror LaTeX assistance', () => {
    test('completes labels, citations, project paths, and user macros', () => {
        assert.deepEqual(completions('\\eqref{eq:'), ['eq:main', 'fig:demo']);
        assert.deepEqual(completions('\\citep{g'), ['greenwade93', 'knuth84']);
        assert.deepEqual(completions('\\input{sections/'), ['main.tex', 'sections/method.tex']);
        assert.deepEqual(completions('\\includegraphics{fig'), ['figures/diagram.pdf', 'figures/pipeline.png']);
        assert.deepEqual(completions('\\cu'), ['\\customMacro', '\\hf']);
    });
});
