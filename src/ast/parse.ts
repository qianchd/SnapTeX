import type { AstParseError, AstParseResult, SnaptexAstRoot } from './types';

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

/**
 * Parses LaTeX into a unified-latex AST without changing the legacy renderer.
 *
 * User documents are often incomplete while typing, so callers must be able to
 * fall back to the existing regex/block pipeline whenever parsing fails.
 */
export async function parseLatexToAst(text: string): Promise<AstParseResult> {
    try {
        const { parse } = await import('@unified-latex/unified-latex-util-parse');
        return {
            ast: parse(text) as SnaptexAstRoot,
            errors: []
        };
    } catch (error) {
        return {
            errors: [parseErrorFromUnknown(error)]
        };
    }
}
