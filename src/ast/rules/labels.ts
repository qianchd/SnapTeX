import { isMacroNode } from '../visit-utils';
import type { AstRenderRule } from './index';
import { readAstCommandArguments } from './index';

export const AST_LABEL_RULE: AstRenderRule = {
    name: 'ast-label',
    match: input => isMacroNode(input.node, 'label'),
    render: (input, context) => {
        const args = readAstCommandArguments(input);
        const label = args.requiredArgs[0];
        return label ? { html: context.renderLabel(label), consumedNodes: args.consumedNodes } : undefined;
    }
};
