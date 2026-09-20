import type { AstParseError, AstParseResult, SnaptexAstNode, SnaptexAstRoot } from './types';

type LatexParser = (text: string) => SnaptexAstRoot;
type LatexMathParser = (text: string) => SnaptexAstNode[];

let loadedParser: LatexParser | undefined;
let loadedMinimalParser: LatexParser | undefined;
let loadedMathParser: LatexMathParser | undefined;

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
            const { parse, parseMathMinimal, parseMinimal } = await import('@unified-latex/unified-latex-util-parse');
            loadedParser = parse as LatexParser;
            loadedMinimalParser = parseMinimal as LatexParser;
            loadedMathParser = parseMathMinimal as LatexMathParser;
        } catch (error) {
            return { errors: [parseErrorFromUnknown(error)] };
        }
    }
    return parseLatexWithLoadedParser(text)!;
}

/** Parses one math node without AST post-processing so source offsets stay local and exact. */
export function parseMathWithLoadedParser(text: string): SnaptexAstNode[] | undefined {
    if (!loadedMathParser) { return undefined; }
    try {
        return loadedMathParser(text);
    } catch {
        return undefined;
    }
}

/** Parses nested source, retaining a minimal AST when full post-processing fails. */
export function parseLatexWithLoadedParser(text: string): AstParseResult | undefined {
    if (!loadedParser) { return undefined; }
    try {
        return { ast: loadedParser(text), errors: [] };
    } catch (error) {
        try {
            return loadedMinimalParser
                ? { ast: loadedMinimalParser(text), errors: [] }
                : { errors: [parseErrorFromUnknown(error)] };
        } catch {
            return { errors: [parseErrorFromUnknown(error)] };
        }
    }
}
