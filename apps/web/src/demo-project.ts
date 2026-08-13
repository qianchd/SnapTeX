import type { BrowserImportFile } from './indexeddb-project';

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

export const DEMO_PROJECT_ID = 'snaptex-demo';
export const DEMO_PROJECT_NAME = 'SnapTeX Demo';

export function loadDemoFiles(): Promise<BrowserImportFile[]> {
    return Promise.all(DEMO_ASSETS.map(fetchAsset));
}
