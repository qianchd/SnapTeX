import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const monochromeSource = readFileSync(new URL('media/icon.svg', root), 'utf8')
    .replace(/<style>[\s\S]*?<\/style>/g, '');

if (process.argv.includes('--png')) {
    const source = monochromeSource.replaceAll('currentColor', '#000');
    for (const [name, size] of [['icon-32.png', 32], ['icon.png', 192], ['icon-512.png', 512]]) {
        const svg = source.replace('<svg ', `<svg width="${size}" height="${size}" xmlns:xlink="http://www.w3.org/1999/xlink" `)
            .replaceAll('href=', 'xlink:href=');
        execFileSync('magick', ['-background', 'none', 'svg:-', '-strip',
            `PNG32:${fileURLToPath(new URL(`media/${name}`, root))}`], { input: svg });
    }
}

if (process.argv.includes('--web')) {
    const pwaSource = monochromeSource.replaceAll('currentColor', '#000')
        .replace(/<svg\b[^>]*>/, '$&<rect x="-512" y="-512" width="1024" height="1024" rx="192" fill="#fff"/><g transform="scale(.8)">')
        .replace('</svg>', '</g></svg>');
    writeFileSync(new URL('media/icon-pwa.svg', root), pwaSource);
}

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
