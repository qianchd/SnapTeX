import { isMacroNode } from '../visit-utils';
import { AST_REF_MACROS, type AstRenderRule, readAstCommandArguments } from './index';

export const AST_REF_RULE: AstRenderRule = (input, context) => {
    if (!isMacroNode(input.node) || !AST_REF_MACROS.has(input.node.content)) {
        return undefined;
    }
    const args = readAstCommandArguments(input);
    const refs = args.requiredArgs[0]?.split(',').map(ref => ref.trim()).filter(Boolean);
    return refs && refs.length > 0
        ? { html: context.renderRef(refs, input.node.content === 'eqref' ? 'eqref' : 'ref'), consumedNodes: args.consumedNodes }
        : undefined;
};
