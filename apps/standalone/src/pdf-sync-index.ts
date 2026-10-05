import { resolveProjectResourcePath } from '../../../src/file-provider';
import type { PdfSyncQuery, PdfSyncResult } from './browser-project';

interface SyncTeXModule {
    FS: { writeFile(path: string, data: Uint8Array): void; unlink(path: string): void };
    HEAPF64: Float64Array;
    UTF8ToString(pointer: number): string;
    _open_index(): number;
    _close_index(): void;
    _first_input(): number;
    _next_input(input: number): number;
    _input_tag(input: number): number;
    _input_name(tag: number): number;
    _forward(tag: number, line: number, column: number, page: number): number;
    _inverse(page: number, x: number, y: number): number;
    _more_results(): number;
}

export function mapSyncTeXInputs(inputs: ReadonlyMap<number, string>, pdfPath: string, rootPath: string, projectPaths: readonly string[]): Map<number, string> {
    const paths = new Set(projectPaths);
    const directory = pdfPath.slice(1, pdfPath.lastIndexOf('/'));
    const absolute = (path: string) => /^(?:\/|[A-Za-z]:\/)/.test(path);
    const names = new Map([...inputs].map(([tag, name]) => [tag, name.replace(/\\/g, '/')]));
    // Only the known root anchors an absolute compile directory, never a basename lookup.
    const pdfSource = pdfPath.replace(/\.pdf$/i, '.tex');
    const anchor = paths.has(pdfSource) ? pdfSource : rootPath;
    const roots = new Set([...names.values()]
        .filter(name => absolute(name) && name.endsWith(anchor))
        .map(name => name.slice(0, -anchor.length)));
    const compileRoot = roots.size === 1 ? [...roots][0] : undefined;
    const mapped = new Map<number, string>();
    for (const [tag, name] of names) {
        const relative = absolute(name)
            ? compileRoot !== undefined && name.startsWith(`${compileRoot}/`) ? name.slice(compileRoot.length + 1) : undefined
            : undefined;
        const resolved = absolute(name)
            ? relative === undefined ? undefined : resolveProjectResourcePath('', relative)
            : resolveProjectResourcePath(directory, name);
        if (resolved !== undefined && paths.has(`/${resolved}`)) {mapped.set(tag, `/${resolved}`);}
    }
    return mapped;
}

/** Uses the official parser unchanged; all returned coordinates are PDF big points. */
export class PdfSyncIndex {
    private constructor(private readonly runtime: SyncTeXModule, private readonly paths: Map<number, string>) {}

    static async open(runtimeUrl: string, data: Uint8Array, compressed: boolean, pdfPath: string, rootPath: string, paths: readonly string[]): Promise<PdfSyncIndex> {
        const { default: createModule } = await import(runtimeUrl) as {
            default: (options: { locateFile: (file: string) => string }) => Promise<SyncTeXModule>
        };
        const runtime = await createModule({ locateFile: file => new URL(file, runtimeUrl).toString() });
        const filename = compressed ? '/document.synctex.gz' : '/document.synctex';
        runtime.FS.writeFile(filename, data);
        const opened = runtime._open_index();
        runtime.FS.unlink(filename);
        if (!opened) {throw new Error('Invalid SyncTeX data.');}
        const inputs = new Map<number, string>();
        for (let input = runtime._first_input(); input; input = runtime._next_input(input)) {
            const tag = runtime._input_tag(input);
            inputs.set(tag, runtime.UTF8ToString(runtime._input_name(tag)));
        }
        return new PdfSyncIndex(runtime, mapSyncTeXInputs(inputs, pdfPath, rootPath, paths));
    }

    query(query: PdfSyncQuery, pageHint = 0): PdfSyncResult | undefined {
        const runtime = this.runtime;
        const tag = query.direction === 'forward' ? [...this.paths].find(([, path]) => path === query.sourcePath)?.[0] : undefined;
        let pointer = query.direction === 'forward'
            ? tag === undefined ? 0 : runtime._forward(tag, query.line, query.column, pageHint)
            : runtime._inverse(query.page, query.x, query.y);
        while (pointer) {
            const values = runtime.HEAPF64.subarray(pointer / 8, pointer / 8 + 11);
            if (query.direction === 'forward') {
                return { page: values[3], x: values[4], y: values[5], boxX: values[6], baseline: values[7],
                    width: values[8], height: values[9], depth: values[10] };
            }
            const path = this.paths.get(values[0]);
            if (path && values[1] > 0) {return { path, line: values[1], column: Math.max(1, values[2]) };}
            pointer = runtime._more_results();
        }
        return undefined;
    }

    close(): void {this.runtime._close_index();}
}
