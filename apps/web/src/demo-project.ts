import type { BrowserWorkspaceTemplate } from './indexeddb-project';

const DEMO_ASSETS = [
    { path: '/main.tex', url: 'demo/main.tex' },
    { path: '/sample.bib', url: 'demo/sample.bib' },
    { path: '/sections/project-editing.tex', url: 'demo/sections/project-editing.tex' },
    { path: '/frog.jpg', url: 'demo/frog.jpg' }
] as const;

async function fetchAsset(asset: typeof DEMO_ASSETS[number]): Promise<{ path: string; file: Blob }> {
    const response = await fetch(asset.url);
    if (!response.ok) {
        throw new Error(`Failed to load ${asset.url}: ${response.status}`);
    }
    return { path: asset.path, file: await response.blob() };
}

export const DEMO_PROJECT_TEMPLATE: BrowserWorkspaceTemplate = {
    id: 'snaptex-demo',
    name: 'SnapTeX Demo',
    files: []
};

export async function loadDemoTemplate(): Promise<BrowserWorkspaceTemplate> {
    return {
        ...DEMO_PROJECT_TEMPLATE,
        files: await Promise.all(DEMO_ASSETS.map(fetchAsset))
    };
}
