const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function patchTikzJaxWorkerBootstrap(tikzDest) {
    const tikzJaxFile = path.join(tikzDest, 'tikzjax.js');
    const runTexFile = path.join(tikzDest, 'run-tex.js');
    const texFilesDir = path.join(tikzDest, 'tex_files');
    const runtimeAssetFiles = [
        'tex.wasm.gz',
        'core.dump.gz',
        ...(
            fs.existsSync(texFilesDir)
                ? fs.readdirSync(texFilesDir)
                    .filter(file => file.endsWith('.gz'))
                    .sort()
                    .map(file => `tex_files/${file}`)
                : []
        )
    ];
    const originalBootstrap = 'const e=N.href.replace(/\\/tikzjax\\.js(?:\\?.*)?$/,""),r=await t(new o(`${e}/run-tex.js`));';
    const patchedBootstrap = `const e=N.href.replace(/\\/tikzjax\\.js(?:\\?.*)?$/,"");let r,snaptexBlobUrls=[],snaptexAssets={};try{const c=async A=>{const t=await fetch(\`${'${'}e}/${'${'}A}\`);if(!t.ok)throw new Error(\`Failed to load ${'${'}A}: ${'${'}t.status}\`);return URL.createObjectURL(await t.blob())};const u=await fetch(\`${'${'}e}/run-tex.js\`);if(!u.ok)throw new Error(\`Failed to load run-tex.js: ${'${'}u.status}\`);const s=URL.createObjectURL(new Blob([await u.text()],{type:"text/javascript"}));snaptexBlobUrls.push(s);for(const A of ${JSON.stringify(runtimeAssetFiles)})snaptexAssets[A]=await c(A),snaptexBlobUrls.push(snaptexAssets[A]);r=await t(new o(s,{CORSWorkaround:!1}),{timeout:60000})}catch(e){throw snaptexBlobUrls.forEach((e=>e&&URL.revokeObjectURL(e))),e}r.__snaptexRunTexBlobUrls=snaptexBlobUrls;`;
    const originalLoad = 'try{await r.load(e)}catch(e){console.log(e)}return r';
    const patchedLoad = 'try{await r.load({base:e,assets:snaptexAssets})}catch(e){try{await n.terminate(r)}finally{r.__snaptexRunTexBlobUrls.forEach((e=>e&&URL.revokeObjectURL(e)))}throw e}return r';
    const originalTerminate = 'Z=async()=>{H&&H.disconnect(),await n.terminate(await V)};';
    const patchedTerminate = 'Z=async()=>{H&&H.disconnect();const e=await V;await n.terminate(e),e.__snaptexRunTexBlobUrls&&e.__snaptexRunTexBlobUrls.forEach((e=>e&&URL.revokeObjectURL(e)))};';
    const originalRunTexFetch = 'let Wn,Zn,zn;const Xn=async A=>{const t=await fetch(`${zn}/${A}`);';
    const patchedRunTexFetch = 'let Wn,Zn,zn,snaptexAssetUrls=null;const Xn=async A=>{const t=await fetch(snaptexAssetUrls&&snaptexAssetUrls[A]||`${zn}/${A}`);';
    const originalRunTexLoad = 'YA({async load(A){zn=A,Zn=await Xn("tex.wasm.gz"),Wn=new Uint8Array(await Xn("core.dump.gz"),0,65536*wn)},async texify';
    const patchedRunTexLoad = 'YA({async load(A){snaptexAssetUrls=A&&A.assets||null,zn=A&&A.base||A,Zn=await Xn("tex.wasm.gz"),Wn=new Uint8Array(await Xn("core.dump.gz"),0,65536*wn)},async texify';

    if (!fs.existsSync(tikzJaxFile) || !fs.existsSync(runTexFile)) {
        return;
    }

    let patched = false;
    let source = fs.readFileSync(tikzJaxFile, 'utf8');
    if (!source.includes(patchedBootstrap) || !source.includes(patchedLoad) || !source.includes(patchedTerminate)) {
        if (!source.includes(originalBootstrap) || !source.includes(originalLoad) || !source.includes(originalTerminate)) {
            console.warn('[build] Warning: TikZJax worker bootstrap patch target not found.');
        } else {
            source = source
                .replace(originalBootstrap, patchedBootstrap)
                .replace(originalLoad, patchedLoad)
                .replace(originalTerminate, patchedTerminate);
            fs.writeFileSync(tikzJaxFile, source);
            patched = true;
        }
    }

    let runTexSource = fs.readFileSync(runTexFile, 'utf8');
    if (!runTexSource.includes(patchedRunTexFetch) || !runTexSource.includes(patchedRunTexLoad)) {
        if (!runTexSource.includes(originalRunTexFetch) || !runTexSource.includes(originalRunTexLoad)) {
            console.warn('[build] Warning: TikZJax run-tex asset loader patch target not found.');
        } else {
            runTexSource = runTexSource
                .replace(originalRunTexFetch, patchedRunTexFetch)
                .replace(originalRunTexLoad, patchedRunTexLoad);
            fs.writeFileSync(runTexFile, runTexSource);
            patched = true;
        }
    }

    if (patched) {
        console.log('[build] Patched TikZJax worker bootstrap.');
    }
}

/**
 * Custom plugin to automatically copy assets (KaTeX, PDF.js, TikZJax) from node_modules to the media directory.
 * This ensures that necessary static files are available for the Webview at runtime.
 * @type {import('esbuild').Plugin}
 */
const copyAssetsPlugin = {
    name: 'copy-assets',
    setup(build) {
        build.onStart(() => {
            console.log('[build] Copying assets...');

            // --- 1. KaTeX Configuration ---
            // Source: node_modules/katex/dist
            // Destination: media/vendor/katex
            const katexSrc = path.join(__dirname, 'node_modules', 'katex', 'dist');
            const katexDest = path.join(__dirname, 'media', 'vendor', 'katex');

            // Create destination directory if it doesn't exist
            if (!fs.existsSync(katexDest)) {
                fs.mkdirSync(katexDest, { recursive: true });
            }

            // Copy KaTeX CSS
            try {
                const cssSrc = path.join(katexSrc, 'katex.min.css');
                const cssDest = path.join(katexDest, 'katex.min.css');
                if (fs.existsSync(cssSrc)) {
                    fs.copyFileSync(cssSrc, cssDest);
                } else {
                    console.warn(`[build] Warning: KaTeX CSS not found at ${cssSrc}`);
                }
            } catch (e) {
                console.error('[build] Failed to copy KaTeX CSS:', e);
            }

            // Copy KaTeX Fonts (Recursively copy all font files)
            const fontsSrc = path.join(katexSrc, 'fonts');
            const fontsDest = path.join(katexDest, 'fonts');
            if (fs.existsSync(fontsSrc)) {
                if (!fs.existsSync(fontsDest)) {
                    fs.mkdirSync(fontsDest, { recursive: true });
                }
                const files = fs.readdirSync(fontsSrc);
                for (const file of files) {
                    fs.copyFileSync(
                        path.join(fontsSrc, file),
                        path.join(fontsDest, file)
                    );
                }
            } else {
                console.warn(`[build] Warning: KaTeX fonts directory not found at ${fontsSrc}`);
            }

            // --- 2. PDF.js Configuration ---
            // Source: node_modules/pdfjs-dist/build
            // Destination: media/vendor/pdfjs
            // Note: pdfjs-dist build artifacts are usually in the 'build' folder
            const pdfjsSrc = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build');
            const pdfjsDest = path.join(__dirname, 'media', 'vendor', 'pdfjs');

            if (!fs.existsSync(pdfjsDest)) {
                fs.mkdirSync(pdfjsDest, { recursive: true });
            }

            // List of PDF.js files to copy
            // We strictly need the main library and the worker script
            const pdfFiles = [
                'pdf.mjs',
                'pdf.worker.mjs'
                // 'pdf.mjs.map', // Optional: Include source maps for debugging
                // 'pdf.worker.mjs.map' // Optional: Include source maps for debugging
            ];

            pdfFiles.forEach(file => {
                const srcFile = path.join(pdfjsSrc, file);
                const destFile = path.join(pdfjsDest, file);
                if (fs.existsSync(srcFile)) {
                    fs.copyFileSync(srcFile, destFile);
                } else {
                    console.warn(`[build] Warning: PDF.js file not found: ${srcFile}`);
                }
            });

            // --- 3. TikZJax Configuration ---
            const tikzRoot = path.join(__dirname, 'node_modules', '@planktimerr', 'tikzjax');
            const tikzDest = path.join(__dirname, 'media', 'vendor', 'tikzjax');

            if (!fs.existsSync(tikzDest)) {
                fs.mkdirSync(tikzDest, { recursive: true });
            }

            const tikzFiles = [
                'tikzjax.js',
                'fonts.css',
                'tex.wasm.gz',
                'run-tex.js',
                'core.dump.gz'

            ];

            // Define search paths relative to the package root
            const searchPaths = ['', 'dist', 'lib', 'build'];

            tikzFiles.forEach(fileName => {
                let found = false;
                for (const subDir of searchPaths) {
                    const srcPath = path.join(tikzRoot, subDir);
                    const srcFile = path.join(srcPath, fileName);
                    const destFile = path.join(tikzDest, fileName);

                    // 1. Try direct copy
                    if (fs.existsSync(srcFile)) {
                        fs.copyFileSync(srcFile, destFile);
                        found = true;
                        break;
                    }

                    // 2. For tex.wasm, try .gz extension and decompress
                    // if (fileName === 'tex.wasm' || 'core.dump') {
                    //     const srcFileGz = srcFile + '.gz';
                    //     if (fs.existsSync(srcFileGz)) {
                    //         console.log(`[build] Found compressed file: ${srcFileGz}. Decompressing...`);
                    //         try {
                    //             const fileBuffer = fs.readFileSync(srcFileGz);
                    //             const decompressed = zlib.gunzipSync(fileBuffer);
                    //             fs.writeFileSync(destFile, decompressed);
                    //             found = true;
                    //             break;
                    //         } catch (err) {
                    //             console.error(`[build] Failed to decompress ${srcFileGz}:`, err);
                    //         }
                    //     }
                    // }
                }

                if (!found) {
                    console.warn(`[build] Warning: TikZJax file not found: ${fileName} in ${tikzRoot}`);
                }
            });
            // Copy tex_files
            const texFilesSrc = path.join(tikzRoot, 'dist', 'tex_files');
            const texFilesDest = path.join(tikzDest, 'tex_files');

            if (fs.existsSync(texFilesSrc)) {
                if (!fs.existsSync(texFilesDest)) fs.mkdirSync(texFilesDest, { recursive: true });
                fs.readdirSync(texFilesSrc).forEach(file => {
                    fs.copyFileSync(path.join(texFilesSrc, file), path.join(texFilesDest, file));
                });
                console.log(`[build] Copied ${fs.readdirSync(texFilesSrc).length} files to tex_files/`);
            }
            patchTikzJaxWorkerBootstrap(tikzDest);

            // Copy Fonts
            const tikzFontsDest = path.join(tikzDest, 'fonts');
            if (!fs.existsSync(tikzFontsDest)) {
                fs.mkdirSync(tikzFontsDest, { recursive: true });
            }

            let fontsFound = false;
            for (const subDir of searchPaths) {
                const fontsSrc = path.join(tikzRoot, subDir, 'fonts');
                if (fs.existsSync(fontsSrc) && fs.statSync(fontsSrc).isDirectory()) {
                    const files = fs.readdirSync(fontsSrc);
                    for (const file of files) {
                        fs.copyFileSync(
                            path.join(fontsSrc, file),
                            path.join(tikzFontsDest, file)
                        );
                    }
                    fontsFound = true;
                    break;
                }
            }
            if (!fontsFound) {
                 console.warn(`[build] Warning: TikZJax fonts directory not found.`);
            }

            console.log('[build] Assets copied successfully.');
        });
    },
};

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
    name: 'esbuild-problem-matcher',

    setup(build) {
        build.onStart(() => {
            console.log('[watch] build started');
        });
        build.onEnd((result) => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`);
                console.error(`    ${location.file}:${location.line}:${location.column}:`);
            });
            console.log('[watch] build finished');
        });
    },
};

async function main() {
    const ctx = await esbuild.context({
        entryPoints: [
            'src/extension.ts'
        ],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: 'dist/extension.js',
        external: ['vscode'],
        logLevel: 'silent',
        plugins: [
            // Register our custom asset copying plugin
            copyAssetsPlugin,
            // Register the default problem matcher plugin
            esbuildProblemMatcherPlugin,
        ],
    });
    if (watch) {
        await ctx.watch();
    } else {
        await ctx.rebuild();
        await ctx.dispose();
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
