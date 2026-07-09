import type { AstParseResult } from './types';
import { parseLatexToAst } from './parse';
import { createDefaultAstRenderContext, renderAstNodesWithRules, type AstRenderContext, type AstRenderRule } from './rules';
import { DEFAULT_AST_RENDER_RULES } from './rules/defaults';
import { createAstBlockArtifactFromParseResult, type AstBlockArtifact } from './block-metadata';
import { escapeHtmlAttribute, stableHash } from '../utils';
import { hasBlockLevelHtml } from '../rule-helpers';

export interface AstBlockWrapperMeta {
    index: number;
    hash?: string;
    line?: number;
    lineCount?: number;
}

export interface AstBlockRenderOptions {
    rules?: readonly AstRenderRule[];
    context?: AstRenderContext;
    parse?: (text: string) => Promise<AstParseResult>;
    wrapper?: AstBlockWrapperMeta;
}

export interface AstBlockRenderResult {
    html: string;
    artifact: AstBlockArtifact;
}

export async function renderLatexBlockWithAst(
    text: string,
    options: AstBlockRenderOptions = {}
): Promise<AstBlockRenderResult> {
    const context = options.context ?? createDefaultAstRenderContext();
    const parseResult = await (options.parse ?? parseLatexToAst)(text);
    const hash = options.wrapper?.hash ?? stableHash(text);
    const artifact = createAstBlockArtifactFromParseResult(parseResult, hash);
    if (!parseResult.ast || parseResult.errors.length > 0) {
        return {
            html: wrapAstBlockHtml(context.escapeHtml(text), text, options.wrapper),
            artifact
        };
    }

    const html = renderAstNodesWithRules(
        parseResult.ast.content,
        options.rules ?? DEFAULT_AST_RENDER_RULES,
        context
    );
    return {
        html: wrapAstBlockHtml(html, text, options.wrapper),
        artifact
    };
}

function wrapAstBlockHtml(html: string, sourceText: string, wrapper: AstBlockWrapperMeta | undefined): string {
    if (!wrapper) {
        return html;
    }

    const attrs = [
        ['class', 'latex-block'],
        ['data-index', String(wrapper.index)],
        ['data-block-hash', wrapper.hash ?? stableHash(sourceText)],
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
