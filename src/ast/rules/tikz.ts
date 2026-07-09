import { renderTikzPictureHtml } from '../../rule-tikz';
import { readLatexGroup } from '../../utils';
import { argumentText, environmentName, isEnvironmentNode, readNodeArgument } from '../visit-utils';
import type { AstRenderRule } from './index';

function tikzSourceFromEnvironment(source: string): { options: string; content: string } | undefined {
    const begin = source.match(/^\\begin\{tikzpicture\}/);
    if (!begin) {
        return undefined;
    }

    let index = begin[0].length;
    let options = '';
    const optionalGroup = readLatexGroup(source, index, { delimiter: 'bracket' });
    if (optionalGroup) {
        options = optionalGroup.content;
        index = optionalGroup.end;
    }

    const endIndex = source.lastIndexOf('\\end{tikzpicture}');
    return endIndex > index
        ? { options, content: source.slice(index, endIndex) }
        : undefined;
}

export const AST_TIKZ_RULE: AstRenderRule = {
    name: 'ast-tikz',
    match: input => environmentName(input.node) === 'tikzpicture',
    render: (input, context) => {
        if (!isEnvironmentNode(input.node) || !Array.isArray(input.node.content)) {
            return undefined;
        }

        const source = tikzSourceFromEnvironment(context.sourceSlice(input.node));
        const options = source?.options ?? argumentText(readNodeArgument(input.node, '[', 0));
        const content = source?.content ?? context.sourceContent(input.node.content);
        const rendered = renderTikzPictureHtml(options, content, context.metadata);
        return {
            html: rendered.html + rendered.hiddenHtml
        };
    }
};
