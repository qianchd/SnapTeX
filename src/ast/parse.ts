import type { AstParseError, AstParseResult, SnaptexAstRoot } from './types';

type LatexParser = (text: string) => SnaptexAstRoot;

let loadedParser: LatexParser | undefined;

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
    if (!loadedParser) {
        try {
            const { parse } = await import('@unified-latex/unified-latex-util-parse');
            loadedParser = parse as LatexParser;
        } catch (error) {
            return { errors: [parseErrorFromUnknown(error)] };
        }
    }
    return parseLatexWithLoadedParser(text)!;
}

/** Parses nested generated source after the lazily loaded AST parser is available. */
export function parseLatexWithLoadedParser(text: string): AstParseResult | undefined {
    if (!loadedParser) { return undefined; }
    try {
        return { ast: loadedParser(text), errors: [] };
    } catch (error) {
        return { errors: [parseErrorFromUnknown(error)] };
    }
}
