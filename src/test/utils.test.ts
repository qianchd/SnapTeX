/// <reference types="mocha" />

import * as assert from 'assert';
import { ProtectionManager } from '../protection';
import { postProcessHtml } from '../rules';
import {
    cleanLatexCommands,
    extractAndHideLabels,
    extractLatexCitationKeys,
    extractLatexLabelNames,
    findCommand,
    readLatexCommandAt,
    readLatexGroup,
    resolveLatexStyles,
    scanLatexBraceBalance,
    splitLatexCitationKeys
} from '../utils';

suite('LaTeX style utilities', () => {
    test('renders common text styles including texttt', () => {
        const html = resolveLatexStyles('\\textbf{B} \\textit{I} \\texttt{T} \\underline{U}');

        assert.match(html, /<strong>B<\/strong>/);
        assert.match(html, /<em>I<\/em>/);
        assert.match(html, /<code>T<\/code>/);
        assert.match(html, /<u>U<\/u>/);
    });

    test('finds nested command content and hides labels with optional whitespace', () => {
        const captionSource = '\\caption[Short]{A {Nested} Caption}';
        const command = findCommand(captionSource, 'caption');
        assert.ok(command);
        assert.equal(command.content, 'A {Nested} Caption');
        assert.equal(command.start, 0);
        assert.equal(command.end, captionSource.length);

        const labels = extractAndHideLabels('Figure body \\label {fig:spaced} text \\label{fig:tight}');
        assert.equal(labels.cleanContent, 'Figure body  text ');
        assert.match(labels.hiddenHtml, /id="fig:spaced"/);
        assert.match(labels.hiddenHtml, /id="fig:tight"/);
        assert.deepEqual(
            extractLatexLabelNames('Figure body \\label {fig:spaced} text \\label{fig:tight}'),
            ['fig:spaced', 'fig:tight']
        );

        const unsafe = extractAndHideLabels('Figure body \\label{fig:a&"b}');
        assert.match(unsafe.hiddenHtml, /id="fig:a&amp;&quot;b"/);
        assert.match(unsafe.hiddenHtml, /data-label="fig:a&amp;&quot;b"/);
    });

    test('splits and extracts LaTeX citation keys consistently', () => {
        assert.deepStrictEqual(splitLatexCitationKeys('smith2024, doe2025 , alpha'), [
            'smith2024',
            'doe2025',
            'alpha'
        ]);

        assert.deepStrictEqual(
            extractLatexCitationKeys('See \\citep[see][p. 2]{smith2024,doe2025} and \\citeyear{smith2024}.'),
            ['smith2024', 'doe2025']
        );
    });

    test('reads balanced groups with stable offsets', () => {
        const braceGroup = readLatexGroup('  {A {Nested} Body} tail', 0);
        assert.ok(braceGroup);
        assert.equal(braceGroup.content, 'A {Nested} Body');
        assert.equal(braceGroup.start, 2);
        assert.equal(braceGroup.end, 19);

        const bracketGroup = readLatexGroup('  [short [nested]]{body}', 0, { delimiter: 'bracket' });
        assert.ok(bracketGroup);
        assert.equal(bracketGroup.content, 'short [nested]');
        assert.equal(bracketGroup.end, 18);
    });

    test('reads commands at the requested position without searching ahead', () => {
        assert.equal(readLatexCommandAt('xx \\href{https://example.com}{Example}', 0, {
            name: 'href',
            requiredArgs: 2
        }), undefined);

        const href = readLatexCommandAt('xx \\href{https://example.com}{Example}', 2, {
            name: 'href',
            requiredArgs: 2
        });
        assert.ok(href);
        assert.equal(href.start, 3);
        assert.equal(href.requiredArgs[0].content, 'https://example.com');
        assert.equal(href.requiredArgs[1].content, 'Example');

        const found = findCommand('before \\caption {A searched caption} after', 'caption');
        assert.ok(found);
        assert.equal(found.content, 'A searched caption');
    });

    test('preserves table command matching contracts', () => {
        const makecell = readLatexCommandAt('\\makecell[c]{A\\\\B}', 0, {
            name: 'makecell',
            requiredArgs: 1,
            optionalArgs: 1,
            skipWhitespace: false
        });
        assert.ok(makecell);
        assert.equal(makecell.optionalArgs[0].content, 'c');
        assert.equal(makecell.requiredArgs[0].content, 'A\\\\B');
        assert.equal(makecell.end, '\\makecell[c]{A\\\\B}'.length);

        const multirow = readLatexCommandAt('\\multirow{2}{*}{A}', 0, {
            name: 'multirow',
            requiredArgs: 3,
            optionalArgs: 1,
            skipWhitespace: false
        });
        assert.ok(multirow);
        assert.deepEqual(multirow.requiredArgs.map(group => group.content), ['2', '*', 'A']);

        assert.equal(readLatexCommandAt('\\makecellx{A}', 0, {
            name: 'makecell',
            requiredArgs: 1,
            optionalArgs: 1,
            skipWhitespace: false
        }), undefined);
    });

    test('scans brace balance with comments and escapes', () => {
        assert.equal(scanLatexBraceBalance('{a \\{ still open % ignored }\n}', { commentMode: 'stop' }).depth, 1);
        assert.equal(scanLatexBraceBalance('{a \\{ still open % skipped }\n}', { commentMode: 'skip-line' }).depth, 0);

        const closed = scanLatexBraceBalance('x {a {b}} y', {
            start: 3,
            initialDepth: 1,
            stopWhenClosed: true
        });
        assert.equal(closed.closedAt, 8);

        const unclosedAfterLineComment = scanLatexBraceBalance('% no newline }\n', {
            initialDepth: 1,
            stopWhenClosed: true,
            commentMode: 'skip-line'
        });
        assert.equal(unclosedAfterLineComment.closedAt, undefined);
    });

    test('cleans common BibTeX LaTeX commands without stripping protected tokens', () => {
        const protector = new ProtectionManager();
        const token = protector.protect('math', '<span>math</span>');
        const cleaned = cleanLatexCommands(`M\\"uller \\textbf{Bold} ${token}`, {
            protectHtml: (namespace: string, content: string) => protector.protect(namespace, content)
        });

        assert.match(cleaned, /M.ller/);
        assert.doesNotMatch(cleaned, /<b>Bold<\/b>/);
        assert.match(protector.resolve(cleaned), /<b>Bold<\/b>/);
        assert.match(protector.resolve(cleaned), /<span>math<\/span>/);

        const unsafe = cleanLatexCommands('\\textbf{<script>alert(1)</script>} <img src=x>', {
            protectHtml: (namespace: string, content: string) => protector.protect(namespace, content)
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
