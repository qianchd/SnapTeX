/// <reference types="mocha" />

import * as assert from 'assert';
import { fillPreviewHtmlTemplate } from '../preview-template';

suite('Preview HTML template', () => {
    test('fills host assets and escapes attribute values', () => {
        const html = fillPreviewHtmlTemplate('<head>{{cspMeta}}\n{{styleLinks}}</head><body{{bodyData}}>{{scripts}}</body>', {
            cspMeta: '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">',
            styleLinks: ['https://example.test/katex.css?a=1&b="2"'],
            bodyData: {
                'data-pdf-js-uri': 'https://example.test/pdf.mjs?x=1&y="2"'
            },
            scripts: ['https://example.test/main.js?x=1&y="2"']
        });

        assert.match(html, /Content-Security-Policy/);
        assert.match(html, /href="https:\/\/example\.test\/katex\.css\?a=1&amp;b=&quot;2&quot;"/);
        assert.match(html, /data-pdf-js-uri="https:\/\/example\.test\/pdf\.mjs\?x=1&amp;y=&quot;2&quot;"/);
        assert.match(html, /src="https:\/\/example\.test\/main\.js\?x=1&amp;y=&quot;2&quot;"/);
        assert.doesNotMatch(html, /{{/);
    });

    test('fails when a template placeholder is not supplied', () => {
        assert.throws(() => fillPreviewHtmlTemplate('{{unknown}}', {
            styleLinks: [],
            bodyData: {},
            scripts: []
        }), /Unreplaced preview HTML placeholder/);
    });
});
