import { renderTikzSourceHtml } from '../../rule-tikz';
import { environmentName, isEnvironmentNode } from '../visit-utils';
import type { AstRenderRule } from './index';

export const AST_TIKZ_RULE: AstRenderRule = (input, context) => {
    if (!isEnvironmentNode(input.node)) {
        return undefined;
    }

    const envName = environmentName(input.node);
    if (!envName || !['tikzpicture', 'tikzcd', 'equation', 'equation*'].includes(envName)) { return undefined; }
    const source = context.sourceSlice(input.node);
    if (envName.startsWith('equation') && !/\\begin\{tikz(?:picture|cd)\}/.test(source)) { return undefined; }

    const html = renderTikzSourceHtml(source, context);
    return html ? { html } : undefined;
};
