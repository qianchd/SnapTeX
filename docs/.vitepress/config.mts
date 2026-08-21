import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
const docsBase = process.env.SNAPTEX_DOCS_BASE ?? '/docs/';

const userSidebar = [
    {
        text: 'User Guide',
        items: [
            { text: 'Overview', link: '/guide/' },
            { text: 'Install SnapTeX', link: '/guide/installation' },
            { text: 'Your First Preview', link: '/guide/getting-started' },
            { text: 'VS Code Extension', link: '/guide/vscode' },
            { text: 'Web App', link: '/guide/web' },
            { text: 'Projects and Files', link: '/guide/projects' }
        ]
    },
    {
        text: 'Use the Preview',
        items: [
            { text: 'Rendering Support', link: '/features/rendering' },
            { text: 'Sync and Navigation', link: '/features/sync' },
            { text: 'Long Documents', link: '/features/long-documents' },
            { text: 'Settings Reference', link: '/reference/settings' },
            { text: 'Troubleshooting', link: '/guide/troubleshooting' }
        ]
    }
];

const deploymentSidebar = [
    {
        text: 'Self-hosting',
        items: [
            { text: 'Choose a Mode', link: '/deployment/overview' },
            { text: 'Static Web and PWA', link: '/deployment/static-web' },
            { text: 'SnapTeX Server', link: '/deployment/server' },
            { text: 'Security Model', link: '/deployment/security' }
        ]
    },
    {
        text: 'Related User Guides',
        collapsed: true,
        items: [
            { text: 'Web App', link: '/guide/web' },
            { text: 'Projects and Files', link: '/guide/projects' },
            { text: 'Troubleshooting', link: '/guide/troubleshooting' }
        ]
    }
];

const apiReferenceItems = [
    { text: 'Source API Scope', link: '/extending/api/scope' },
    { text: 'Call Relationships', link: '/extending/api/call-relationships' },
    {
        text: 'Contracts',
        collapsed: true,
        items: [
            { text: 'Registry', link: '/extending/api/contracts/registry' },
            { text: 'Legacy Rules', link: '/extending/api/contracts/legacy-rules' },
            { text: 'AST Rules', link: '/extending/api/contracts/ast-rules' },
            { text: 'Metadata and Dependencies', link: '/extending/api/contracts/metadata-dependencies' },
            { text: 'Splitter', link: '/extending/api/contracts/splitter' }
        ]
    },
    {
        text: 'Registry Functions',
        collapsed: true,
        items: [
            { text: 'defineRuleRegistry', link: '/extending/api/registry/define-rule-registry' },
            { text: 'defineAstRenderRule', link: '/extending/api/registry/define-ast-render-rule' },
            { text: 'defineBlockDependencyRule', link: '/extending/api/registry/define-block-dependency-rule' }
        ]
    },
    {
        text: 'Legacy Rules and Context',
        collapsed: true,
        items: [
            { text: 'PreprocessRule.apply', link: '/extending/api/legacy/apply' },
            { text: 'protectHtml', link: '/extending/api/legacy/protect-html' },
            { text: 'renderInline', link: '/extending/api/legacy/render-inline' },
            { text: 'resolveCitation', link: '/extending/api/legacy/resolve-citation' },
            { text: 'getCitedKeys', link: '/extending/api/legacy/get-cited-keys' }
        ]
    },
    {
        text: 'Source Readers',
        collapsed: true,
        items: [
            { text: 'replaceLatexCommandCalls', link: '/extending/api/source/replace-latex-command-calls' },
            { text: 'readLatexGroup', link: '/extending/api/source/read-latex-group' },
            { text: 'readLatexCommandAt', link: '/extending/api/source/read-latex-command-at' },
            { text: 'skipLatexWhitespace', link: '/extending/api/source/skip-latex-whitespace' },
            { text: 'stripLatexComments', link: '/extending/api/source/strip-latex-comments' }
        ]
    },
    {
        text: 'Rendering Functions',
        collapsed: true,
        items: [
            { text: 'escapeHtml', link: '/extending/api/rendering/escape-html' },
            { text: 'renderMath', link: '/extending/api/rendering/render-math' },
            { text: 'renderInlineLatexHtml', link: '/extending/api/rendering/render-inline-latex-html' }
        ]
    },
    {
        text: 'AST Rules and Context',
        collapsed: true,
        items: [
            { text: 'AstRenderRule', link: '/extending/api/ast/render' },
            { text: 'readAstCommandArguments', link: '/extending/api/ast/read-ast-command-arguments' },
            { text: 'isMacroNode', link: '/extending/api/ast/is-macro-node' },
            { text: 'isEnvironmentNode', link: '/extending/api/ast/is-environment-node' },
            { text: 'environmentName', link: '/extending/api/ast/environment-name' },
            { text: 'readRequiredMacroArgument', link: '/extending/api/ast/read-required-macro-argument' },
            { text: 'readOptionalMacroArgument', link: '/extending/api/ast/read-optional-macro-argument' },
            { text: 'argumentText', link: '/extending/api/ast/argument-text' },
            { text: 'renderChildren', link: '/extending/api/ast/render-children' },
            { text: 'renderSource', link: '/extending/api/ast/render-source' },
            { text: 'context.escapeHtml', link: '/extending/api/ast/context-escape-html' },
            { text: 'context.sourceSlice', link: '/extending/api/ast/context-source-slice' },
            { text: 'context.sourceContent', link: '/extending/api/ast/context-source-content' },
            { text: 'context.renderMath', link: '/extending/api/ast/context-render-math' },
            { text: 'context.renderLabel', link: '/extending/api/ast/context-render-label' },
            { text: 'context.renderRef', link: '/extending/api/ast/context-render-ref' },
            { text: 'context.resolveCitation', link: '/extending/api/ast/context-resolve-citation' },
            { text: 'context.renderCitation', link: '/extending/api/ast/context-render-citation' },
            { text: 'context.getCitedKeys', link: '/extending/api/ast/context-get-cited-keys' },
            { text: 'context.renderImage', link: '/extending/api/ast/context-render-image' }
        ]
    },
    {
        text: 'Metadata and Dependencies',
        collapsed: true,
        items: [
            { text: 'MetadataExtractor', link: '/extending/api/metadata/extract' },
            { text: 'readMetadataCommand', link: '/extending/api/metadata/read-metadata-command' },
            { text: 'BlockDependencyRule', link: '/extending/api/dependencies/collect' },
            { text: 'deps.metadata', link: '/extending/api/dependencies/metadata' },
            { text: 'deps.citedKeys', link: '/extending/api/dependencies/cited-keys' }
        ]
    },
    {
        text: 'Testing API',
        collapsed: true,
        items: [
            { text: 'PreviewUpdateService', link: '/extending/api/testing/preview-update-service' },
            { text: 'render', link: '/extending/api/testing/render' },
            { text: 'renderBlockByIndex', link: '/extending/api/testing/render-block-by-index' },
            { text: 'resetState', link: '/extending/api/testing/reset-state' },
            { text: 'getDiagnostics', link: '/extending/api/testing/get-diagnostics' },
            { text: 'getPreviewSyncData', link: '/extending/api/testing/get-preview-sync-data' },
            { text: 'getSourceSyncData', link: '/extending/api/testing/get-source-sync-data' },
            { text: 'isKnownFile', link: '/extending/api/testing/is-known-file' },
            { text: 'getBibliographyKeys', link: '/extending/api/testing/get-bibliography-keys' },
            { text: 'getMacroNames', link: '/extending/api/testing/get-macro-names' }
        ]
    }
];

const developerSidebar = [
    {
        text: 'Developer Guide',
        items: [
            { text: 'Overview', link: '/development/' },
            { text: 'Development Setup', link: '/development/getting-started' },
            { text: 'Architecture', link: '/development/architecture' },
            { text: 'Rendering Pipeline', link: '/development/rendering-pipeline' },
            { text: 'Testing Changes', link: '/development/testing' }
        ]
    },
    {
        text: 'Extend SnapTeX',
        items: [
            { text: 'Choose an Extension Point', link: '/extending/' },
            { text: 'Rendering Rules Tutorial', link: '/extending/rules' },
            { text: 'Metadata and Dependencies', link: '/extending/metadata' },
            { text: 'Rule API Overview', link: '/extending/rule-api' }
        ]
    },
    {
        text: 'API Reference',
        collapsed: true,
        items: apiReferenceItems
    },
    {
        text: 'Internals',
        collapsed: true,
        items: [
            { text: 'AST Backend', link: '/development/ast-backend' },
            { text: 'Sync Model', link: '/development/sync-model' },
            { text: 'Performance', link: '/development/performance' }
        ]
    }
];

export default withMermaid(defineConfig({
    title: 'SnapTeX Documentation',
    description: 'Guides and reference for the SnapTeX LaTeX previewer, Web app, and server.',
    base: docsBase,
    mermaid: {
        securityLevel: 'strict',
        startOnLoad: false
    },
    cleanUrls: true,
    lastUpdated: true,
    head: [
        ['link', { rel: 'icon', href: `${docsBase}icon.png` }],
        ['meta', { name: 'theme-color', content: '#0f766e' }]
    ],
    themeConfig: {
        logo: '/icon.png',
        siteTitle: 'SnapTeX Docs',
        nav: [
            { text: 'User Guide', link: '/guide/', activeMatch: '^/(guide|features|reference)/' },
            { text: 'Self-hosting', link: '/deployment/overview', activeMatch: '^/deployment/' },
            { text: 'Developer Guide', link: '/development/', activeMatch: '^/(development|extending)/' },
            { text: `v${version}`, link: 'https://github.com/qianchd/SnapTeX/releases' },
            { text: 'Open Web App', link: 'https://qianchd.github.io/SnapTeX/' }
        ],
        sidebar: {
            '/guide/': userSidebar,
            '/features/': userSidebar,
            '/reference/': userSidebar,
            '/deployment/': deploymentSidebar,
            '/development/': developerSidebar,
            '/extending/': developerSidebar
        },
        search: { provider: 'local' },
        outline: { level: [2, 3] },
        editLink: {
            pattern: 'https://github.com/qianchd/SnapTeX/edit/master/docs/:path',
            text: 'Edit this page on GitHub'
        },
        socialLinks: [
            { icon: 'github', link: 'https://github.com/qianchd/SnapTeX' }
        ],
        footer: {
            message: 'A fast structural preview, not a replacement for a full TeX compiler.',
            copyright: `SnapTeX ${version} · GPL-3.0-or-later`
        }
    }
}));
