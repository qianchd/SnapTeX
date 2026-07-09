import { splitLatexCitationKeys } from '../utils';
import { parseLatexToAst } from './parse';
import { AST_CITATION_MACROS, AST_REF_MACROS, AST_SECTION_MACROS } from './rules';
import type { AstParseResult, SnaptexAstNode, SnaptexAstRoot } from './types';
import {
    astNodeRange,
    collectMacroArgumentTexts,
    environmentName,
    isEnvironmentNode,
    isMacroNode,
    visitLatexAst
} from './visit-utils';

export const AST_SOURCE_HINT_KIND = {
    InlineMath: 1,
    DisplayMath: 2,
    Ref: 3,
    Citation: 4,
    Section: 5,
    ListItem: 6
} as const;

type AstSourceHintKind = typeof AST_SOURCE_HINT_KIND[keyof typeof AST_SOURCE_HINT_KIND];

export interface AstBlockMetadata {
    labels: string[];
    citations: string[];
    environments: string[];
    macros: string[];
}

export interface CompactSourceHints {
    starts: Uint32Array;
    ends: Uint32Array;
    kinds: Uint8Array;
}

export interface AstBlockArtifact {
    hash: string;
    parseOk: boolean;
    metadata: AstBlockMetadata;
    sourceHints: CompactSourceHints;
}

function pushUnique(values: string[], value: string | undefined) {
    if (value && !values.includes(value)) {
        values.push(value);
    }
}

function emptyMetadata(): AstBlockMetadata {
    return {
        labels: [],
        citations: [],
        environments: [],
        macros: []
    };
}

function emptySourceHints(): CompactSourceHints {
    return {
        starts: new Uint32Array(0),
        ends: new Uint32Array(0),
        kinds: new Uint8Array(0)
    };
}

export async function extractAstBlockArtifact(
    blockText: string,
    hash: string,
    parse: (text: string) => Promise<AstParseResult> = parseLatexToAst
): Promise<AstBlockArtifact> {
    return createAstBlockArtifactFromParseResult(await parse(blockText), hash);
}

export function createAstBlockArtifactFromParseResult(result: AstParseResult, hash: string): AstBlockArtifact {
    const metadata = emptyMetadata();
    if (!result.ast || result.errors.length > 0) {
        return {
            hash,
            parseOk: false,
            metadata,
            sourceHints: emptySourceHints()
        };
    }

    collectAstBlockMetadata(result.ast, metadata);
    return {
        hash,
        parseOk: true,
        metadata,
        sourceHints: collectSourceHints(result.ast)
    };
}

function collectAstBlockMetadata(root: SnaptexAstRoot, metadata: AstBlockMetadata): void {
    collectMacroArgumentTexts(root.content, 'label').forEach(label => pushUnique(metadata.labels, label));
    for (const macroName of AST_CITATION_MACROS) {
        collectMacroArgumentTexts(root.content, macroName)
            .flatMap(splitLatexCitationKeys)
            .forEach(key => pushUnique(metadata.citations, key));
    }

    visitLatexAst(root, node => {
        if (isEnvironmentNode(node)) {
            pushUnique(metadata.environments, environmentName(node));
            return;
        }

        if (!isMacroNode(node)) {
            return;
        }

        pushUnique(metadata.macros, node.content);
    });
}

function collectSourceHints(root: SnaptexAstRoot): CompactSourceHints {
    const starts: number[] = [];
    const ends: number[] = [];
    const kinds: number[] = [];
    const pushHint = (kind: AstSourceHintKind, node: SnaptexAstNode) => {
        const range = astNodeRange(node);
        if (!range || range.end <= range.start) { return; }
        starts.push(range.start);
        ends.push(range.end);
        kinds.push(kind);
    };

    visitLatexAst(root, node => {
        if (node.type === 'inlinemath') {
            pushHint(AST_SOURCE_HINT_KIND.InlineMath, node);
            return;
        }
        if (node.type === 'displaymath' || isEnvironmentNode(node, 'equation') || isEnvironmentNode(node, 'equation*')) {
            pushHint(AST_SOURCE_HINT_KIND.DisplayMath, node);
            return;
        }
        if (!isMacroNode(node)) {
            return;
        }
        if (AST_REF_MACROS.has(node.content)) {
            pushHint(AST_SOURCE_HINT_KIND.Ref, node);
            return;
        }
        if (AST_CITATION_MACROS.has(node.content)) {
            pushHint(AST_SOURCE_HINT_KIND.Citation, node);
            return;
        }
        if (AST_SECTION_MACROS.has(node.content)) {
            pushHint(AST_SOURCE_HINT_KIND.Section, node);
            return;
        }
        if (node.content === 'item') {
            pushHint(AST_SOURCE_HINT_KIND.ListItem, node);
        }
    });

    return {
        starts: new Uint32Array(starts),
        ends: new Uint32Array(ends),
        kinds: new Uint8Array(kinds)
    };
}
