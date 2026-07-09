import type { SnaptexAstMacro } from '../visit-utils';
import { argumentText, isMacroNode, readNodeArgument, readRequiredMacroArgument } from '../visit-utils';
import { AST_SECTION_MACROS, type AstRenderRule, readAstCommandArguments } from './index';

const SECTION_TAGS: Record<string, string> = {
    section: 'h2',
    subsection: 'h3',
    subsubsection: 'h4',
    paragraph: 'h5',
    subparagraph: 'h6'
};

function sectionName(node: SnaptexAstMacro): string {
    const name = String(node.content);
    return name.endsWith('*') ? name.slice(0, -1) : name;
}

function isStarredSection(node: SnaptexAstMacro): boolean {
    return String(node.content).endsWith('*')
        || argumentText(readNodeArgument(node, '', 0)).trim() === '*';
}

export const AST_SECTION_RULE: AstRenderRule = {
    name: 'ast-section',
    match: input => isMacroNode(input.node) && AST_SECTION_MACROS.has(sectionName(input.node)),
    render: (input, context) => {
        if (!isMacroNode(input.node)) {
            return undefined;
        }

        const args = readAstCommandArguments(input);
        const level = sectionName(input.node);
        const titleArgument = readRequiredMacroArgument(input.node);
        const content = (titleArgument ? argumentText(titleArgument) : args.requiredArgs[0])?.trim();
        if (!content) {
            return undefined;
        }

        const tag = SECTION_TAGS[level] ?? 'h2';
        const numberHtml = isStarredSection(input.node) || level === 'paragraph' || level === 'subparagraph'
            ? ''
            : '<span class="sn-cnt" data-type="sec"></span>. ';
        const titleHtml = titleArgument
            ? input.renderChildren(titleArgument.content).trim()
            : context.escapeHtml(content);
        return { html: `<${tag}>${numberHtml}${titleHtml}</${tag}>`, consumedNodes: args.consumedNodes };
    }
};
