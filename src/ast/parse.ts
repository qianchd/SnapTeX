import type { AstParseError, AstParseResult, SnaptexAstNode } from './types';

let parsers: typeof import('@unified-latex/unified-latex-util-parse', { with: { 'resolution-mode': 'import' } }) | undefined;
let printer: typeof import('@unified-latex/unified-latex-util-print-raw', { with: { 'resolution-mode': 'import' } }) | undefined;

function parseErrorFromUnknown(error: unknown): AstParseError {
    if (error instanceof Error) {
        const line = typeof (error as Error & { line?: unknown }).line === 'number'
            ? (error as Error & { line: number }).line
            : undefined;
        const column = typeof (error as Error & { column?: unknown }).column === 'number'
            ? (error as Error & { column: number }).column
            : undefined;
        return { message: error.message, line, column };
    }
    return { message: String(error) };
}

/** Parses LaTeX through the shared, lazily loaded unified-latex parser. */
export async function parseLatexToAst(text: string): Promise<AstParseResult> {
    if (!parsers || !printer) {
        try {
            [parsers, printer] = await Promise.all([
                import('@unified-latex/unified-latex-util-parse'),
                import('@unified-latex/unified-latex-util-print-raw')
            ]);
        } catch (error) {
            return { errors: [parseErrorFromUnknown(error)] };
        }
    }
    return parseLatexWithLoadedParser(text)!;
}

export function printLatexWithLoadedPrinter(nodes: readonly SnaptexAstNode[]): string | undefined {
    return printer?.printRaw(nodes as unknown as Parameters<typeof printer.printRaw>[0]);
}

/** Parses one math node without AST post-processing so source offsets stay local and exact. */
export function parseMathWithLoadedParser(text: string): SnaptexAstNode[] | undefined {
    try {
        return parsers?.parseMathMinimal(text);
    } catch {
        return undefined;
    }
}

/** Parses nested source, retaining a minimal AST when full post-processing fails. */
export function parseLatexWithLoadedParser(text: string): AstParseResult | undefined {
    if (!parsers) { return undefined; }
    try {
        return { ast: parsers.parse(text), errors: [] };
    } catch (error) {
        try {
            return { ast: parsers.parseMinimal(text), errors: [] };
        } catch {
            return { errors: [parseErrorFromUnknown(error)] };
        }
    }
}
