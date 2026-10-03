import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);

if (process.argv.includes('--docs')) {
    mkdirSync(new URL('docs/public/', root), { recursive: true });
    copyFileSync(new URL('media/icon.svg', root), new URL('docs/public/icon.svg', root));
}

if (process.argv.includes('--vscode')) {
    // Marketplace disallows custom SVG images in extension descriptions.
    const readme = readFileSync(new URL('README.md', root), 'utf8')
        .replace('src="media/icon.svg"', 'src="media/icon-512.png"');
    mkdirSync(new URL('dist/', root), { recursive: true });
    writeFileSync(new URL('dist/README.md', root), readme);
}
