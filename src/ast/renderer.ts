import type { AstBlockArtifact, AstParseResult } from './types';
import { parseLatexToAst } from './parse';
import { createDefaultAstRenderContext, renderAstNodesWithRules, type AstRenderContext, type AstRenderRule } from './rules';
import { DEFAULT_AST_RENDER_RULES } from './rules/defaults';
import { createAstBlockArtifactFromParseResult } from './block-metadata';
import { escapeHtmlAttribute, stableHash } from '../utils';
import { hasBlockLevelHtml } from '../rule-helpers';

interface AstBlockWrapperMeta {
    index: number;
    hash?: string;
    line?: number;
    lineCount?: number;
}

interface AstBlockRenderOptions {
    rules?: readonly AstRenderRule[];
    context?: AstRenderContext;
    parse?: (text: string) => Promise<AstParseResult>;
    artifact?: AstBlockArtifact;
    wrapper?: AstBlockWrapperMeta;
}

interface AstBlockRenderResult {
    html: string;
    artifact: AstBlockArtifact;
}

export async function renderLatexBlockWithAst(
    text: string,
    options: AstBlockRenderOptions = {}
): Promise<AstBlockRenderResult> {
    const context = options.context ?? createDefaultAstRenderContext({ sourceText: text });
    const parseResult = await (options.parse ?? parseLatexToAst)(text);
    const hash = options.wrapper?.hash ?? stableHash(text);
    const parseOk = !!parseResult.ast && parseResult.errors.length === 0;
    const artifact = options.artifact?.hash === hash && options.artifact.parseOk === parseOk
        ? options.artifact
        : createAstBlockArtifactFromParseResult(parseResult, hash);
    const html = parseResult.ast && parseOk
        ? renderAstNodesWithRules(parseResult.ast.content, options.rules ?? DEFAULT_AST_RENDER_RULES, context)
        : context.escapeHtml(text);
    return {
        html: wrapAstBlockHtml(html, hash, options.wrapper),
        artifact
    };
}

function wrapAstBlockHtml(html: string, hash: string, wrapper: AstBlockWrapperMeta | undefined): string {
    if (!wrapper) {
        return html;
    }

    const attrs = [
        ['class', 'latex-block'],
        ['data-index', String(wrapper.index)],
        ['data-block-hash', hash],
        wrapper.line !== undefined ? ['data-line', String(wrapper.line)] : undefined,
        wrapper.lineCount !== undefined ? ['data-line-count', String(wrapper.lineCount)] : undefined
    ]
        .filter((attr): attr is [string, string] => attr !== undefined)
        .map(([name, value]) => `${name}="${escapeHtmlAttribute(value)}"`)
        .join(' ');
    return `<div ${attrs}>${wrapPlainParagraphs(html)}</div>`;
}

function wrapPlainParagraphs(html: string): string {
    if (hasBlockLevelHtml(html)) {
        return html;
    }

    return html
        .split(/\n\s*\n/g)
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => `<p>${part}</p>`)
        .join('');
}
