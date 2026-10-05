import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const source = resolve(root, '.tmp-synctex/synctex');
const output = resolve(root, 'apps/standalone/vendor/synctex');
const revision = '04cf8e3e8665ff203248d7af78ee1129afbc1b64';
if (!existsSync(source)) {
    execFileSync('git', ['clone', 'https://github.com/jlaurens/synctex.git', source], { stdio: 'inherit' });
}
execFileSync('git', ['checkout', revision], { cwd: source, stdio: 'inherit' });
mkdirSync(output, { recursive: true });
// Prebuilt files are committed; ordinary application builds do not need Emscripten.
const windows = process.platform === 'win32';
const emcc = process.env.EMCC || (windows
    ? execFileSync('where.exe', ['emcc'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
    : 'emcc');
const compiler = windows ? process.env.EMSDK_PYTHON || 'python' : emcc;
execFileSync(compiler, [
    ...(windows ? [emcc.replace(/\.bat$/i, '.py')] : []),
    resolve(root, 'tools/synctex/api.c'),
    resolve(source, 'synctex_parser.c'), resolve(source, 'synctex_parser_utils.c'),
    '-I', source, '-O3', '-sUSE_ZLIB=1', '-sMODULARIZE=1', '-sEXPORT_ES6=1',
    '-sENVIRONMENT=web,worker,node', '-sALLOW_MEMORY_GROWTH=1', '-sMAXIMUM_MEMORY=268435456',
    '-sFILESYSTEM=1', '-sEXPORTED_RUNTIME_METHODS=FS,UTF8ToString,HEAPF64',
    '-o', resolve(output, 'synctex.mjs')
], { stdio: 'inherit' });
