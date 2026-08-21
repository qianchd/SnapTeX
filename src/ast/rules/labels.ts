import { isMacroNode } from '../visit-utils';
import { readAstCommandArguments, type AstRenderRule } from './index';

export const AST_LABEL_RULE: AstRenderRule = (input, context) => {
    if (!isMacroNode(input.node, 'label')) { return undefined; }
    const args = readAstCommandArguments(input);
    const label = args.requiredArgs[0];
    return label ? { html: context.renderLabel(label), consumedNodes: args.consumedNodes } : undefined;
};
