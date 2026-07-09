import { isMacroNode } from '../visit-utils';
import type { AstRenderRule } from './index';
import { readAstCommandArguments } from './index';

export const AST_INCLUDEGRAPHICS_RULE: AstRenderRule = {
    name: 'ast-includegraphics',
    match: input => isMacroNode(input.node, 'includegraphics'),
    render: (input, context) => {
        const args = readAstCommandArguments(input);
        const path = args.requiredArgs[0];
        return path
            ? { html: context.renderImage(path, args.optionalArgs[0]), consumedNodes: args.consumedNodes }
            : undefined;
    }
};
