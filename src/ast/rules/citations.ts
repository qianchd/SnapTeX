import { splitLatexCitationKeys } from '../../utils';
import { isMacroNode } from '../visit-utils';
import { AST_CITATION_MACROS, type AstRenderRule, readAstCommandArguments } from './index';

export const AST_CITATION_RULE: AstRenderRule = {
    name: 'ast-citation',
    match: input => isMacroNode(input.node) && AST_CITATION_MACROS.has(input.node.content),
    render: (input, context) => {
        if (!isMacroNode(input.node)) {
            return undefined;
        }

        const args = readAstCommandArguments(input);
        const keys = splitLatexCitationKeys(args.requiredArgs[0] ?? '').filter(Boolean);
        if (keys.length === 0) {
            return undefined;
        }

        const firstOptional = args.optionalArgs[0];
        const secondOptional = args.optionalArgs[1];
        return {
            html: context.renderCitation(input.node.content, keys, {
                pre: secondOptional !== undefined ? firstOptional : undefined,
                post: secondOptional ?? firstOptional
            }),
            consumedNodes: args.consumedNodes
        };
    }
};
