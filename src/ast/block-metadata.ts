import { splitLatexCitationKeys } from '../utils';
import { parseLatexToAst } from './parse';
import { AST_CITATION_MACROS, AST_REF_MACROS, AST_SECTION_MACROS } from './rules';
import type { AstBlockArtifact, AstBlockMetadata, AstParseResult, CompactSourceHints, SnaptexAstRoot } from './types';
import {
    argumentText,
    astNodeRange,
    astNodesToText,
    environmentName,
    isGroupNode,
    isEnvironmentNode,
    isMacroNode,
    readRequiredMacroArgument,
    visitLatexAst
} from './visit-utils';

function pushUnique(values: string[], value: string | undefined) {
    if (value && !values.includes(value)) {
        values.push(value);
    }
}

export async function extractAstBlockArtifact(
    blockText: string,
    hash: string,
    parse: (text: string) => Promise<AstParseResult> = parseLatexToAst
): Promise<AstBlockArtifact> {
    return createAstBlockArtifactFromParseResult(await parse(blockText), hash);
}

export function createAstBlockArtifactFromParseResult(result: AstParseResult, hash: string): AstBlockArtifact {
    const metadata: AstBlockMetadata = {
        labels: [],
        citations: [],
        environments: [],
        macros: []
    };
    if (!result.ast || result.errors.length > 0) {
        return {
            hash,
            parseOk: false,
            metadata,
            sourceHints: {
                starts: new Uint32Array(0),
                ends: new Uint32Array(0)
            }
        };
    }

    const sourceHints = collectAstBlockData(result.ast, metadata);
    return {
        hash,
        parseOk: true,
        metadata,
        sourceHints
    };
}

function collectAstBlockData(root: SnaptexAstRoot, metadata: AstBlockMetadata): CompactSourceHints {
    const starts: number[] = [];
    const ends: number[] = [];
    visitLatexAst(root, (node, index, siblings) => {
        const isTrackedMacro = isMacroNode(node) && (
            AST_REF_MACROS.has(node.content)
            || AST_CITATION_MACROS.has(node.content)
            || AST_SECTION_MACROS.has(node.content)
            || node.content === 'item'
        );
        if (node.type === 'inlinemath'
            || node.type === 'displaymath'
            || node.type === 'mathenv'
            || isTrackedMacro) {
            const range = astNodeRange(node);
            if (range && range.end > range.start) {
                starts.push(range.start);
                ends.push(range.end);
            }
        }

        if (isEnvironmentNode(node)) {
            pushUnique(metadata.environments, environmentName(node));
            return;
        }

        if (!isMacroNode(node)) {
            return;
        }

        pushUnique(metadata.macros, node.content);
        if (node.content !== 'label' && !AST_CITATION_MACROS.has(node.content)) {
            return;
        }
        const attached = argumentText(readRequiredMacroArgument(node));
        const next = siblings[index + 1];
        const value = attached || (isGroupNode(next) ? astNodesToText(next.content) : '');
        if (node.content === 'label') {
            pushUnique(metadata.labels, value);
        } else {
            splitLatexCitationKeys(value).forEach(key => pushUnique(metadata.citations, key));
        }
    });

    return {
        starts: new Uint32Array(starts),
        ends: new Uint32Array(ends)
    };
}
