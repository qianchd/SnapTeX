import { argumentText, isMacroNode, readNodeArgument, type SnaptexAstMacro } from '../visit-utils';
import { AST_SECTION_MACROS, readAstCommandNodeArguments, type AstRenderRule } from './index';

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

export const AST_SECTION_RULE: AstRenderRule = input => {
    if (!isMacroNode(input.node) || !AST_SECTION_MACROS.has(sectionName(input.node))) {
        return undefined;
    }

    const args = readAstCommandNodeArguments(input);
    const level = sectionName(input.node);
    const title = args.requiredArgs[0];
    if (!title || title.length === 0) {
        return undefined;
    }

    const tag = SECTION_TAGS[level] ?? 'h2';
    const numberHtml = isStarredSection(input.node) || level === 'paragraph' || level === 'subparagraph'
        ? ''
        : '<span class="sn-cnt" data-type="sec"></span>. ';
    return {
        html: `<${tag}>${numberHtml}${input.renderChildren(title).trim()}</${tag}>`,
        consumedNodes: args.consumedNodes
    };
};
