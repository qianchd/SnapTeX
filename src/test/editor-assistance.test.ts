/// <reference types="mocha" />

import * as assert from 'assert';
import { EditorState, type Transaction } from '@codemirror/state';
import { CompletionContext, type CompletionSource } from '@codemirror/autocomplete';
import { indentService } from '@codemirror/language';
import { snaptexInsertNewline, snaptexLatexCompletionSources } from '../../apps/standalone/src/editor-assistance';

const sources = snaptexLatexCompletionSources(() => ({
    labels: ['eq:main', 'fig:demo'],
    citationKeys: ['greenwade93', 'knuth84'],
    projectPaths: ['/main.tex', '/sections/method.tex', '/figures/pipeline.png', '/figures/diagram.pdf'],
    macros: ['\\hf', 'customMacro']
}));

async function completions(source: CompletionSource, doc: string) {
    const state = EditorState.create({ doc });
    const result = await source(new CompletionContext(state, doc.length, true));
    assert.ok(result);
    return result.options.map(option => option.label);
}

function applyNewline(doc: string): string {
    const cursor = doc.indexOf('|');
    assert.ok(cursor >= 0);
    const state = EditorState.create({
        doc: doc.slice(0, cursor) + doc.slice(cursor + 1),
        selection: { anchor: cursor },
        extensions: indentService.of(() => 2)
    });
    let transaction: Transaction | undefined;
    assert.ok(snaptexInsertNewline({
        state,
        dispatch: nextTransaction => {
            transaction = nextTransaction;
        }
    }));
    assert.ok(transaction);
    return transaction.state.doc.toString();
}

suite('CodeMirror LaTeX assistance', () => {
    test('completes labels, citations, project paths, and user macros', async () => {
        const projectSource = sources[0];
        assert.deepEqual(await completions(projectSource, '\\eqref{eq:'), ['eq:main', 'fig:demo']);
        assert.deepEqual(await completions(projectSource, '\\citep{g'), ['greenwade93', 'knuth84']);
        assert.deepEqual(await completions(projectSource, '\\input{sections/'), ['main.tex', 'sections/method.tex']);
        assert.deepEqual(await completions(projectSource, '\\includegraphics{fig'), ['figures/diagram.pdf', 'figures/pipeline.png']);
        assert.deepEqual(await completions(projectSource, '\\cu'), ['\\customMacro', '\\hf']);
    });

    test('delegates common LaTeX commands and environments to codemirror-lang-latex', async () => {
        const commonSource = sources[1];
        const textCommandLabels = await completions(commonSource, '\\textb');
        const sectionCommandLabels = await completions(commonSource, '\\subs');
        const beginEnvironmentLabels = await completions(commonSource, '\\begin{ali');
        const endEnvironmentLabels = await completions(commonSource, '\\end{the');
        assert.ok(textCommandLabels.includes('\\textbf'));
        assert.ok(sectionCommandLabels.includes('\\subsection'));
        assert.ok(beginEnvironmentLabels.includes('align'));
        assert.ok(endEnvironmentLabels.includes('theorem'));
    });

    test('keeps normal paragraphs flush-left when pressing Enter', () => {
        assert.equal(
            applyNewline('\\section{Intro}\nA paragraph.|'),
            '\\section{Intro}\nA paragraph.\n'
        );
    });

    test('auto-closes selected begin environments on Enter', () => {
        assert.equal(
            applyNewline('\\begin{itemize}|'),
            '\\begin{itemize}\n  \n\\end{itemize}'
        );
        assert.equal(
            applyNewline('\\begin{align*}|'),
            '\\begin{align*}\n  \n\\end{align*}'
        );
    });

    test('keeps outer wrapper environments flush-left on Enter', () => {
        assert.equal(
            applyNewline('\\begin{document}|'),
            '\\begin{document}\n'
        );
        assert.equal(
            applyNewline('\\begin{figure}[H]|'),
            '\\begin{figure}[H]\n'
        );
    });
});
