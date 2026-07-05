const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function replaceOrThrow(source, patch) {
    if (source.includes(patch.replacement)) {
        return { source, patched: false };
    }
    if (!source.includes(patch.original)) {
        throw new Error(`[build] TikZJax ${patch.label} patch target not found.`);
    }
    return {
        source: source.replace(patch.original, patch.replacement),
        patched: true
    };
}

function applyTextPatches(source, patches) {
    let patched = false;
    for (const patch of patches) {
        const result = replaceOrThrow(source, patch);
        source = result.source;
        patched = patched || result.patched;
    }
    return { source, patched };
}

function createTikzJaxBootstrapPatch(runtimeAssetFiles) {
    return [
        'const e=N.href.replace(/\\/tikzjax\\.js(?:\\?.*)?$/,"");',
        'let r,snaptexBlobUrls=[],snaptexAssets={};',
        'try{',
        `const c=async A=>{const t=await fetch(\`${'${'}e}/${'${'}A}\`);if(!t.ok)throw new Error(\`Failed to load ${'${'}A}: ${'${'}t.status}\`);return URL.createObjectURL(await t.blob())};`,
        `const u=await fetch(\`${'${'}e}/run-tex.js\`);`,
        `if(!u.ok)throw new Error(\`Failed to load run-tex.js: ${'${'}u.status}\`);`,
        'const s=URL.createObjectURL(new Blob([await u.text()],{type:"text/javascript"}));',
        'snaptexBlobUrls.push(s);',
        `await Promise.all(${JSON.stringify(runtimeAssetFiles)}.map((async A=>{snaptexAssets[A]=await c(A),snaptexBlobUrls.push(snaptexAssets[A])})));`,
        'r=await t(new o(s,{CORSWorkaround:!1}),{timeout:60000})',
        '}catch(e){throw snaptexBlobUrls.forEach((e=>e&&URL.revokeObjectURL(e))),e}',
        'r.__snaptexRunTexBlobUrls=snaptexBlobUrls;'
    ].join('');
}

function createTikzJaxSourcePatches(runtimeAssetFiles) {
    return [
        {
            label: 'worker bootstrap',
            original: 'const e=N.href.replace(/\\/tikzjax\\.js(?:\\?.*)?$/,""),r=await t(new o(`${e}/run-tex.js`));',
            replacement: createTikzJaxBootstrapPatch(runtimeAssetFiles)
        },
        {
            label: 'worker load args',
            original: 'try{await r.load(e)}catch(e){console.log(e)}return r',
            replacement: 'try{await r.load({base:e,assets:snaptexAssets})}catch(e){try{await n.terminate(r)}finally{r.__snaptexRunTexBlobUrls.forEach((e=>e&&URL.revokeObjectURL(e)))}throw e}return r'
        },
        {
            label: 'worker terminate cleanup',
            original: 'Z=async()=>{H&&H.disconnect(),await n.terminate(await V)};',
            replacement: 'Z=async()=>{H&&H.disconnect();const e=await V;await n.terminate(e),e.__snaptexRunTexBlobUrls&&e.__snaptexRunTexBlobUrls.forEach((e=>e&&URL.revokeObjectURL(e)))};'
        },
        {
            label: 'stale script queue guard',
            original: 's=async e=>{const t=e.childNodes[0].nodeValue',
            replacement: 's=async e=>{if(!e.isConnected&&(!e.loader||!e.loader.isConnected))return;const t=e.childNodes[0].nodeValue'
        },
        {
            label: 'compile failure event',
            original: 'catch(e){return console.log(e),void(r.outerHTML=\'<img src="//invalid.site/img-not-found.png">\')}',
            replacement: 'catch(e){console.log(e);const t=new CustomEvent("tikzjax-load-failed",{bubbles:!0,detail:{message:e&&e.message?e.message:"TikZ rendering failed."}});return void r.dispatchEvent(t)}'
        },
        {
            label: 'disconnected loader guard',
            original: 'if(r.replaceWith(a),!e.dataset.disableCache)try{',
            replacement: 'if(!r.isConnected)return;if(r.replaceWith(a),!e.dataset.disableCache)try{'
        }
    ];
}

function createRunTexSourcePatches() {
    return [
        {
            label: 'run-tex asset fetch',
            original: 'let Wn,Zn,zn;const Xn=async A=>{const t=await fetch(`${zn}/${A}`);',
            replacement: 'let Wn,Zn,zn,snaptexAssetUrls=null;const Xn=async A=>{const t=await fetch(snaptexAssetUrls&&snaptexAssetUrls[A]||`${zn}/${A}`);'
        },
        {
            label: 'run-tex load args',
            original: 'YA({async load(A){zn=A,Zn=await Xn("tex.wasm.gz"),Wn=new Uint8Array(await Xn("core.dump.gz"),0,65536*wn)},async texify',
            replacement: 'YA({async load(A){snaptexAssetUrls=A&&A.assets||null,zn=A&&A.base||A,Zn=await Xn("tex.wasm.gz"),Wn=new Uint8Array(await Xn("core.dump.gz"),0,65536*wn)},async texify'
        }
    ];
}

function patchTextFile(filePath, patches) {
    const result = applyTextPatches(fs.readFileSync(filePath, 'utf8'), patches);
    if (result.patched) {
        fs.writeFileSync(filePath, result.source);
    }
    return result.patched;
}

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
    if (!fs.existsSync(tikzJaxFile) || !fs.existsSync(runTexFile)) {
        return;
    }

    const tikzJaxPatched = patchTextFile(tikzJaxFile, createTikzJaxSourcePatches(runtimeAssetFiles));
    const runTexPatched = patchTextFile(runTexFile, createRunTexSourcePatches());
    const patched = tikzJaxPatched || runTexPatched;

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
    const extensionCtx = await esbuild.context({
        entryPoints: [
            'apps/vscode/src/extension.ts'
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

    const webviewMainCtx = await esbuild.context({
        entryPoints: ['src/webview/main.ts'],
        bundle: true,
        format: 'iife',
        globalName: 'SnapTeXWebview',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'browser',
        target: 'es2022',
        outfile: 'media/webview-main.js',
        logLevel: 'silent',
        plugins: [esbuildProblemMatcherPlugin],
    });

    const webviewPdfCtx = await esbuild.context({
        entryPoints: ['src/webview/pdf.ts'],
        bundle: true,
        format: 'iife',
        globalName: 'SnapTeXPdfRuntime',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'browser',
        target: 'es2022',
        outfile: 'media/webview-pdf.js',
        logLevel: 'silent',
        plugins: [esbuildProblemMatcherPlugin],
    });

    const webAppCtx = await esbuild.context({
        entryPoints: ['apps/web/src/main.ts'],
        bundle: true,
        format: 'iife',
        globalName: 'SnapTeXStandaloneWeb',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'browser',
        target: 'es2022',
        outfile: 'apps/web/dist/web-main.js',
        logLevel: 'silent',
        plugins: [esbuildProblemMatcherPlugin],
    });

    const contexts = [extensionCtx, webviewMainCtx, webviewPdfCtx, webAppCtx];
    if (watch) {
        await Promise.all(contexts.map(ctx => ctx.watch()));
    } else {
        await Promise.all(contexts.map(ctx => ctx.rebuild()));
        await Promise.all(contexts.map(ctx => ctx.dispose()));
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
