/// <reference types="mocha" />

import * as assert from 'assert';
import { BibTexParser } from '../bib';
import { ProtectionManager } from '../protection';

suite('BibTexParser', () => {
    test('parses simple entries with nested brace fields', () => {
        const entries = BibTexParser.parse(`
            @article{smith2024,
              author = {Smith, Jane and Doe, John},
              title = {A {Nested} Title},
              journal = "Journal of Tests",
              year = {2024}
            }
        `);

        const entry = entries.get('smith2024');
        assert.ok(entry);
        assert.equal(entry.type, 'article');
        assert.equal(entry.fields.author, 'Smith, Jane and Doe, John');
        assert.equal(entry.fields.title, 'A {Nested} Title');
        assert.equal(entry.fields.journal, 'Journal of Tests');
        assert.equal(entry.fields.year, '2024');
    });

    test('formats authors with accents and multiple BibTeX name forms', () => {
        const entries = BibTexParser.parse(`
            @article{accented,
              author = {M\\"uller, Ada and John Smith and Jane Doe},
              title = {Title},
              year = {2024}
            }
        `);

        const entry = entries.get('accented');
        assert.ok(entry);
        assert.equal(BibTexParser.getShortAuthor(entry), 'Muller <em>et al.</em>');
    });

    test('parses inline thebibliography bibitems', () => {
        const entries = BibTexParser.parseBibItems(`
            \\begin{thebibliography}{99}
            \\bibitem{rivera2027}
            Rivera, A., \\& Quinn, B. (2027). Synthetic inline references. \\textit{Journal of Preview Fixtures}, \\textbf{12}, 34--56.

            %\\bibitem{hidden2025}
            %Commented, A. (2015). Hidden entry.

            \\bibitem{vale2027}
            Vale, C., Reed, D., \\& Sol, E. (2027). Another synthetic reference.
            \\end{thebibliography}
        `);

        const entry = entries.get('rivera2027');
        assert.ok(entry);
        assert.equal(entry.type, 'bibitem');
        assert.equal(entry.fields.year, '2027');
        assert.match(entry.fields.raw, /Journal of Preview Fixtures/);
        assert.equal(BibTexParser.getShortAuthor(entry), 'Rivera &amp; Quinn');
        assert.ok(!entries.has('hidden2025'));

        const protector = new ProtectionManager();
        const html = protector.resolve(BibTexParser.formatEntry(entry, { protectHtml: protector.protect.bind(protector) }));
        assert.match(html, /Rivera, A\., &amp; Quinn, B\./);
        assert.match(html, /<i>Journal of Preview Fixtures<\/i>/);
    });

    test('escapes formatted bibliography fields and rejects unsafe URLs', () => {
        const protector = new ProtectionManager();
        const renderer = { protectHtml: protector.protect.bind(protector) };
        const entry = {
            key: 'unsafe',
            type: 'article',
            fields: {
                author: 'Eve <img src=x onerror=alert(1)>',
                title: '\\textbf{Bold <script>alert(1)</script>}',
                journal: 'Journal & Review',
                year: '2026"><script>',
                doi: '10.1/example" onclick="alert(1)<x>'
            }
        };

        const html = protector.resolve(BibTexParser.formatEntry(entry, renderer));

        assert.doesNotMatch(html, /<script|<img|onclick="/i);
        assert.match(html, /Eve &lt;img src=x onerror=alert\(1\)&gt;/);
        assert.match(html, /<b>Bold &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/b>/);
        assert.match(html, /2026&quot;&gt;&lt;script&gt;/);
        assert.match(html, /href="https:\/\/doi\.org\/10\.1\/example%22%20onclick=%22alert\(1\)%3Cx%3E"/);

        const unsafeUrlEntry = {
            key: 'bad-url',
            type: 'misc',
            fields: {
                title: 'Unsafe URL',
                url: 'javascript:alert(1)'
            }
        };
        assert.doesNotMatch(BibTexParser.formatEntry(unsafeUrlEntry, renderer), /href=/i);
    });
});
