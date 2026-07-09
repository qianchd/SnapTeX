import type { BrowserProjectFile } from './browser-file-provider';

interface StandaloneDemoProjectAsset {
    path: string;
    url: string;
    text?: boolean;
}

const STANDALONE_DEMO_PROJECT_ASSETS: readonly StandaloneDemoProjectAsset[] = [
    { path: '/demo/main.tex', url: 'demo/main.tex', text: true },
    { path: '/demo/sample.bib', url: 'demo/sample.bib', text: true },
    { path: '/demo/sections/project-editing.tex', url: 'demo/sections/project-editing.tex', text: true },
    { path: '/demo/frog.jpg', url: 'demo/frog.jpg' }
];

async function fetchText(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to load ${url}: ${response.status}`);
    }
    return response.text();
}

export function createStandaloneDemoProjectFiles(readText: (url: string) => Promise<string> = fetchText): BrowserProjectFile[] {
    return STANDALONE_DEMO_PROJECT_ASSETS.map(file => file.text
        ? { path: file.path, readText: () => readText(file.url) }
        : { path: file.path, resourceUrl: file.url });
}
