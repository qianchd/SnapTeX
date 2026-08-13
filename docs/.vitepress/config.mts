import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitepress';

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

const developerSidebar = [
    {
        text: 'Developer Guide',
        items: [
            { text: 'Overview', link: '/development/' },
            { text: 'Development Setup', link: '/development/getting-started' },
            { text: 'Architecture', link: '/development/architecture' },
            { text: 'Rendering Pipeline', link: '/development/rendering-pipeline' }
        ]
    },
    {
        text: 'Extend SnapTeX',
        items: [
            { text: 'Extension Model', link: '/extending/' },
            { text: 'Rendering Rules Tutorial', link: '/extending/rules' },
            { text: 'Rule API Reference', link: '/extending/rule-api' },
            { text: 'Metadata and Dependencies', link: '/extending/metadata' }
        ]
    },
    {
        text: 'Internals',
        collapsed: true,
        items: [
            { text: 'AST Backend', link: '/development/ast-backend' },
            { text: 'Sync Model', link: '/development/sync-model' },
            { text: 'Performance', link: '/development/performance' },
            { text: 'Testing', link: '/development/testing' }
        ]
    }
];

export default defineConfig({
    title: 'SnapTeX Documentation',
    description: 'Guides and reference for the SnapTeX LaTeX previewer, Web app, and server.',
    base: docsBase,
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
            { text: 'User Guide', link: '/guide/' },
            { text: 'Self-hosting', link: '/deployment/overview' },
            { text: 'Developer Guide', link: '/development/' },
            { text: 'Rule API', link: '/extending/rule-api' },
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
});
