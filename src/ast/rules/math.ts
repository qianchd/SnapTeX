import { extractAndHideLabels } from '../../utils';
import { renderNumberedEquationHtml } from '../../rule-helpers';
import { astNodesToLatex, environmentName, getSourcePosition } from '../visit-utils';
import type { AstRenderContext, AstRenderRule } from './index';

function isMathNodeType(type: string): boolean {
    return type === 'inlinemath' || type === 'displaymath' || type === 'mathenv';
}

function isFollowedByText(input: Parameters<AstRenderRule['render']>[0]): boolean {
    for (let index = input.index + 1; index < input.siblings.length; index++) {
        const node = input.siblings[index];
        if (node.type === 'whitespace') {
            continue;
        }
        return node.type !== 'parbreak';
    }
    return false;
}

interface MathRefPlaceholder {
    token: string;
    html: string;
    text: string;
}

function replaceMathRefs(tex: string, context: AstRenderContext): { tex: string; refs: MathRefPlaceholder[] } {
    const refs: MathRefPlaceholder[] = [];
    const replaced = tex.replace(/\\(ref|eqref)\*?\{([^}]+)\}/g, (_match, type: 'ref' | 'eqref', rawKey: string) => {
        const labels = rawKey.split(',').map(key => key.trim()).filter(Boolean);
        if (labels.length === 0) {
            return '';
        }

        const token = `SNAPTEXMATHREF${refs.length}`;
        refs.push({
            token,
            html: context.renderRef(labels, type),
            text: type === 'eqref' ? '(?)' : '?'
        });
        return `\\text{${token}}`;
    });
    return { tex: replaced, refs };
}

function applyMathRefPlaceholders(html: string, refs: readonly MathRefPlaceholder[]): string {
    if (refs.length === 0) {
        return html;
    }

    const marker = '<span class="katex-html"';
    const markerIndex = html.indexOf(marker);
    const replaceTokens = (input: string, field: 'html' | 'text') => refs.reduce(
        (current, ref) => current.split(ref.token).join(ref[field]),
        input
    );

    if (markerIndex === -1) {
        return replaceTokens(html, 'html');
    }
    return replaceTokens(html.slice(0, markerIndex), 'text') + replaceTokens(html.slice(markerIndex), 'html');
}

function wrapSourceAnchor(html: string, node: Parameters<AstRenderRule['render']>[0]['node'], displayMode: boolean): string {
    const position = getSourcePosition(node);
    if (!position) {
        return html;
    }
    const kind = displayMode ? 'display-math' : 'inline-math';
    return `<span class="snaptex-source-anchor" data-sn-src-kind="${kind}" data-sn-src-start="${position.start.offset}" data-sn-src-end="${position.end.offset}">${html}</span>`;
}

export const AST_MATH_RULE: AstRenderRule = {
    name: 'ast-math',
    match: input => isMathNodeType(input.node.type),
    render: (input, context) => {
        const node = input.node;
        const displayMode = node.type === 'displaymath' || node.type === 'mathenv';
        const envName = environmentName(node);
        const rawContent = Array.isArray(node.content)
            ? astNodesToLatex(node.content)
            : (typeof node.content === 'string' ? node.content : '');
        const { cleanContent, hiddenHtml } = extractAndHideLabels(rawContent);
        let tex = cleanContent.trim();

        if (envName) {
            const normalized = envName.toLowerCase().replace(/\*$/, '');
            if (['align', 'flalign', 'alignat', 'multline'].includes(normalized)) {
                tex = `\\begin{aligned}\n${tex}\n\\end{aligned}`;
            } else if (normalized === 'gather') {
                tex = `\\begin{gathered}\n${tex}\n\\end{gathered}`;
            }
        }

        const mathRefs = replaceMathRefs(tex, context);
        const mathHtml = wrapSourceAnchor(
            applyMathRefPlaceholders(context.renderMath(mathRefs.tex, displayMode), mathRefs.refs),
            node,
            displayMode
        );
        const numbered = node.type === 'mathenv' && !(envName ?? '').endsWith('*');
        const html = numbered
            ? renderNumberedEquationHtml(mathHtml, '(<span class="sn-cnt" data-type="eq"></span>)', hiddenHtml)
            : `${mathHtml}${hiddenHtml}`;
        return {
            html: html + (displayMode && isFollowedByText(input) ? '<span class="no-indent-marker"></span>' : '')
        };
    }
};
