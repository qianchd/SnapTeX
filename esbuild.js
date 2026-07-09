const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const MEDIA_VENDOR = path.join(ROOT, "media", "vendor");
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const buildTarget = process.argv.find(arg => arg.startsWith('--target='))?.split('=')[1] || 'all';

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function copyFileIfExists(source, destination, warningLabel) {
    if (fs.existsSync(source)) {
        ensureDir(path.dirname(destination));
        fs.copyFileSync(source, destination);
        return true;
    }
    console.warn(`[build] Warning: ${warningLabel} not found at ${source}`);
    return false;
}

function copyDirectoryFiles(sourceDir, destinationDir, filter = () => true) {
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
        return 0;
    }
    ensureDir(destinationDir);
    const files = fs.readdirSync(sourceDir).filter(filter);
    for (const file of files) {
        fs.copyFileSync(path.join(sourceDir, file), path.join(destinationDir, file));
    }
    return files.length;
}

function firstExistingFile(root, searchDirs, fileName) {
    for (const subDir of searchDirs) {
        const candidate = path.join(root, subDir, fileName);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

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
        "const e=N.href.replace(/\\/tikzjax\\.js(?:\\?.*)?$/,\"\");",
        "let r,snaptexBlobUrls=[],snaptexAssets={};",
        "try{",
        `const c=async A=>{const t=await fetch(\`${"${"}e}/${"${"}A}\`);if(!t.ok)throw new Error(\`Failed to load ${"${"}A}: ${"${"}t.status}\`);return URL.createObjectURL(await t.blob())};`,
        `const u=await fetch(\`${"${"}e}/run-tex.js\`);`,
        `if(!u.ok)throw new Error(\`Failed to load run-tex.js: ${"${"}u.status}\`);`,
        "const s=URL.createObjectURL(new Blob([await u.text()],{type:'text/javascript'}));",
        "snaptexBlobUrls.push(s);",
        `await Promise.all(${JSON.stringify(runtimeAssetFiles)}.map((async A=>{snaptexAssets[A]=await c(A),snaptexBlobUrls.push(snaptexAssets[A])})));`,
        "r=await t(new o(s,{CORSWorkaround:!1}),{timeout:60000})",
        "}catch(e){throw snaptexBlobUrls.forEach((e=>e&&URL.revokeObjectURL(e))),e}",
        "r.__snaptexRunTexBlobUrls=snaptexBlobUrls;"
    ].join("");
}

function createTikzJaxSourcePatches(runtimeAssetFiles) {
    return [
        {
            label: "worker bootstrap",
            original: "const e=N.href.replace(/\\/tikzjax\\.js(?:\\?.*)?$/,\"\"),r=await t(new o(`${e}/run-tex.js`));",
            replacement: createTikzJaxBootstrapPatch(runtimeAssetFiles)
        },
        {
            label: "worker load args",
            original: "try{await r.load(e)}catch(e){console.log(e)}return r",
            replacement: "try{await r.load({base:e,assets:snaptexAssets})}catch(e){try{await n.terminate(r)}finally{r.__snaptexRunTexBlobUrls.forEach((e=>e&&URL.revokeObjectURL(e)))}throw e}return r"
        },
        {
            label: "worker terminate cleanup",
            original: "Z=async()=>{H&&H.disconnect(),await n.terminate(await V)};",
            replacement: "Z=async()=>{H&&H.disconnect();const e=await V;await n.terminate(e),e.__snaptexRunTexBlobUrls&&e.__snaptexRunTexBlobUrls.forEach((e=>e&&URL.revokeObjectURL(e)))};"
        },
        {
            label: "stale script queue guard",
            original: "s=async e=>{const t=e.childNodes[0].nodeValue",
            replacement: "s=async e=>{if(!e.isConnected&&(!e.loader||!e.loader.isConnected))return;const t=e.childNodes[0].nodeValue"
        },
        {
            label: "compile failure event",
            original: "catch(e){return console.log(e),void(r.outerHTML='<img src=\"//invalid.site/img-not-found.png\">')}",
            replacement: "catch(e){console.log(e);const t=new CustomEvent('tikzjax-load-failed',{bubbles:!0,detail:{message:e&&e.message?e.message:'TikZ rendering failed.'}});return void r.dispatchEvent(t)}"
        },
        {
            label: "disconnected loader guard",
            original: "if(r.replaceWith(a),!e.dataset.disableCache)try{",
            replacement: "if(!r.isConnected)return;if(r.replaceWith(a),!e.dataset.disableCache)try{"
        }
    ];
}

function createRunTexSourcePatches() {
    return [
        {
            label: "run-tex asset fetch",
            original: "let Wn,Zn,zn;const Xn=async A=>{const t=await fetch(`${zn}/${A}`);",
            replacement: "let Wn,Zn,zn,snaptexAssetUrls=null;const Xn=async A=>{const t=await fetch(snaptexAssetUrls&&snaptexAssetUrls[A]||`${zn}/${A}`);"
        },
        {
            label: "run-tex load args",
            original: "YA({async load(A){zn=A,Zn=await Xn(\"tex.wasm.gz\"),Wn=new Uint8Array(await Xn(\"core.dump.gz\"),0,65536*wn)},async texify",
            replacement: "YA({async load(A){snaptexAssetUrls=A&&A.assets||null,zn=A&&A.base||A,Zn=await Xn(\"tex.wasm.gz\"),Wn=new Uint8Array(await Xn(\"core.dump.gz\"),0,65536*wn)},async texify"
        }
    ];
}

function patchTextFile(filePath, patches) {
    const result = applyTextPatches(fs.readFileSync(filePath, "utf8"), patches);
    if (result.patched) {
        fs.writeFileSync(filePath, result.source);
    }
    return result.patched;
}

function patchTikzJaxWorkerBootstrap(tikzDest) {
    const tikzJaxFile = path.join(tikzDest, "tikzjax.js");
    const runTexFile = path.join(tikzDest, "run-tex.js");
    const texFilesDir = path.join(tikzDest, "tex_files");
    const runtimeAssetFiles = [
        "tex.wasm.gz",
        "core.dump.gz",
        ...(
            fs.existsSync(texFilesDir)
                ? fs.readdirSync(texFilesDir)
                    .filter(file => file.endsWith(".gz"))
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
    if (tikzJaxPatched || runTexPatched) {
        console.log("[build] Patched TikZJax worker bootstrap.");
    }
}

function copyKatexAssets() {
    const katexSrc = path.join(ROOT, "node_modules", "katex", "dist");
    const katexDest = path.join(MEDIA_VENDOR, "katex");

    copyFileIfExists(
        path.join(katexSrc, "katex.min.css"),
        path.join(katexDest, "katex.min.css"),
        "KaTeX CSS"
    );
    if (copyDirectoryFiles(path.join(katexSrc, "fonts"), path.join(katexDest, "fonts")) === 0) {
        console.warn(`[build] Warning: KaTeX fonts directory not found at ${path.join(katexSrc, "fonts")}`);
    }
}

function copyPdfAssets() {
    const pdfjsSrc = path.join(ROOT, "node_modules", "pdfjs-dist", "build");
    const pdfjsDest = path.join(MEDIA_VENDOR, "pdfjs");
    for (const file of ["pdf.mjs", "pdf.worker.mjs"]) {
        copyFileIfExists(path.join(pdfjsSrc, file), path.join(pdfjsDest, file), "PDF.js file");
    }
}

function copyTikzAssets() {
    const tikzRoot = path.join(ROOT, "node_modules", "@planktimerr", "tikzjax");
    const tikzDest = path.join(MEDIA_VENDOR, "tikzjax");
    const searchDirs = ["", "dist", "lib", "build"];

    ensureDir(tikzDest);
    for (const file of ["tikzjax.js", "fonts.css", "tex.wasm.gz", "run-tex.js", "core.dump.gz"]) {
        const source = firstExistingFile(tikzRoot, searchDirs, file);
        if (source) {
            fs.copyFileSync(source, path.join(tikzDest, file));
        } else {
            console.warn(`[build] Warning: TikZJax file not found: ${file} in ${tikzRoot}`);
        }
    }

    const texFilesSrc = path.join(tikzRoot, "dist", "tex_files");
    const texFileCount = copyDirectoryFiles(texFilesSrc, path.join(tikzDest, "tex_files"));
    if (texFileCount > 0) {
        console.log(`[build] Copied ${texFileCount} files to tex_files/`);
    }

    patchTikzJaxWorkerBootstrap(tikzDest);

    const fontsDest = path.join(tikzDest, "fonts");
    const fontsSrc = searchDirs
        .map(subDir => path.join(tikzRoot, subDir, "fonts"))
        .find(dir => fs.existsSync(dir) && fs.statSync(dir).isDirectory());
    if (!fontsSrc || copyDirectoryFiles(fontsSrc, fontsDest) === 0) {
        console.warn("[build] Warning: TikZJax fonts directory not found.");
    }
}

function copyRuntimeAssets() {
    console.log("[build] Copying assets...");
    copyKatexAssets();
    copyPdfAssets();
    copyTikzAssets();
    console.log("[build] Assets copied successfully.");
}

function createCopyAssetsPlugin() {
    return {
        name: "copy-assets",
        setup(build) {
            build.onStart(copyRuntimeAssets);
        }
    };
}

function createProblemMatcherPlugin() {
    return {
        name: "esbuild-problem-matcher",
        setup(build) {
            build.onStart(() => {
                console.log("[watch] build started");
            });
            build.onEnd(result => {
                result.errors.forEach(({ text, location }) => {
                    console.error(`x [ERROR] ${text}`);
                    console.error(`    ${location.file}:${location.line}:${location.column}:`);
                });
                console.log("[watch] build finished");
            });
        }
    };
}

function baseBuildOptions(platform, outfile, plugins) {
    return {
        bundle: true,
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform,
        outfile,
        logLevel: "silent",
        plugins
    };
}

function extensionBuildOptions(problemMatcher) {
    return {
        ...baseBuildOptions("node", "dist/extension.js", [
            createCopyAssetsPlugin(),
            problemMatcher
        ]),
        entryPoints: ["apps/vscode/src/extension.ts"],
        format: "cjs",
        external: ["vscode"]
    };
}

function browserBuildOptions(entryPoint, outfile, globalName, problemMatcher, extraPlugins = []) {
    return {
        ...baseBuildOptions("browser", outfile, [...extraPlugins, problemMatcher]),
        entryPoints: [entryPoint],
        format: "iife",
        globalName,
        target: "es2022"
    };
}

function buildOptions() {
    const problemMatcher = createProblemMatcherPlugin();
    const options = [];
    if (buildTarget === 'all' || buildTarget === 'vscode') {
        options.push(extensionBuildOptions(problemMatcher));
        options.push(browserBuildOptions("src/webview/main.ts", "media/webview-main.js", "SnapTeXWebview", problemMatcher));
        options.push(browserBuildOptions("src/webview/pdf.ts", "media/webview-pdf.js", "SnapTeXPdfRuntime", problemMatcher));
    }
    if (buildTarget === 'all' || buildTarget === 'web') {
        if (buildTarget === 'web') {
            options.push(browserBuildOptions("src/webview/main.ts", "media/webview-main.js", "SnapTeXWebview", problemMatcher, [createCopyAssetsPlugin()]));
            options.push(browserBuildOptions("src/webview/pdf.ts", "media/webview-pdf.js", "SnapTeXPdfRuntime", problemMatcher));
        }
        options.push(browserBuildOptions("apps/web/src/main.ts", "apps/web/dist/web-main.js", "SnapTeXStandaloneWeb", problemMatcher));
    }
    return options;
}

async function main() {
    const contexts = await Promise.all(buildOptions().map(options => esbuild.context(options)));
    if (watch) {
        await Promise.all(contexts.map(context => context.watch()));
    } else {
        await Promise.all(contexts.map(context => context.rebuild()));
        await Promise.all(contexts.map(context => context.dispose()));
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
