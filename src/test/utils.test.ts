/// <reference types="mocha" />

import * as assert from 'assert';
import { ProtectionManager } from '../protection';
import { postProcessHtml } from '../rules';
import { cleanLatexCommands, extractAndHideLabels, findCommand, resolveLatexStyles } from '../utils';

suite('LaTeX style utilities', () => {
    test('renders common text styles including texttt', () => {
        const html = resolveLatexStyles('\\textbf{B} \\textit{I} \\texttt{T} \\underline{U}');

        assert.match(html, /<strong>B<\/strong>/);
        assert.match(html, /<em>I<\/em>/);
        assert.match(html, /<code>T<\/code>/);
        assert.match(html, /<u>U<\/u>/);
    });

    test('finds nested command content and hides labels with optional whitespace', () => {
        const command = findCommand('\\caption[Short]{A {Nested} Caption}', 'caption');
        assert.ok(command);
        assert.equal(command.content, 'A {Nested} Caption');

        const labels = extractAndHideLabels('Figure body \\label {fig:spaced} text \\label{fig:tight}');
        assert.equal(labels.cleanContent, 'Figure body  text ');
        assert.match(labels.hiddenHtml, /id="fig:spaced"/);
        assert.match(labels.hiddenHtml, /id="fig:tight"/);

        const unsafe = extractAndHideLabels('Figure body \\label{fig:a&"b}');
        assert.match(unsafe.hiddenHtml, /id="fig:a&amp;&quot;b"/);
        assert.match(unsafe.hiddenHtml, /data-label="fig:a&amp;&quot;b"/);
    });

    test('cleans common BibTeX LaTeX commands without stripping protected tokens', () => {
        const protector = new ProtectionManager();
        const token = protector.protect('math', '<span>math</span>');
        const cleaned = cleanLatexCommands(`M\\"uller \\textbf{Bold} ${token}`, {
            protect: (namespace: string, content: string) => protector.protect(namespace, content)
        });

        assert.match(cleaned, /M.ller/);
        assert.doesNotMatch(cleaned, /<b>Bold<\/b>/);
        assert.match(protector.resolve(cleaned), /<b>Bold<\/b>/);
        assert.match(protector.resolve(cleaned), /<span>math<\/span>/);

        const unsafe = cleanLatexCommands('\\textbf{<script>alert(1)</script>} <img src=x>', {
            protect: (namespace: string, content: string) => protector.protect(namespace, content)
        });
        assert.doesNotMatch(protector.resolve(unsafe), /<script|<img/i);
        assert.match(protector.resolve(unsafe), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    });

    test('post-processes abstract and keyword sentinel blocks', () => {
        const html = postProcessHtml([
            '<p>OOABSTRACT_STARTOO</p>',
            '<p>This is the abstract.</p>',
            '<p>OOABSTRACT_ENDOO</p>',
            '<p>OOKEYWORDS_STARTOOalpha; betaOOKEYWORDS_ENDOO</p>'
        ].join(''));

        assert.match(html, /<div class="latex-abstract"><span class="latex-abstract-title">Abstract<\/span>/);
        assert.match(html, /<p>This is the abstract\.<\/p><\/div>/);
        assert.match(html, /<div class="latex-keywords"><strong>Keywords:<\/strong> alpha; beta<\/div>/);
        assert.doesNotMatch(html, /OOABSTRACT|OOKEYWORDS/);
    });
});
