import {
    LATEX_CONTENT_WRAPPER_COMMANDS,
    LATEX_DIMENSION_SOURCE,
    LATEX_INLINE_NOTE_COMMANDS,
    LATEX_LAYOUT_BREAK_COMMANDS,
    LATEX_LAYOUT_SWITCH_COMMANDS,
    LATEX_OMITTED_ARGUMENT_COMMANDS,
    LATEX_PREVIEW_OMITTED_COMMANDS,
    LATEX_TEXT_ACCENTS,
    LATEX_UNBRACED_SPACING_COMMANDS,
    TRANSPARENT_CONTAINER_ENVIRONMENTS
} from '../../patterns';
import { renderInlineNoteHtml, siunitxArgumentCount, siunitxMathSource } from '../../rule-helpers';
import { formatLatexRomanNumeral, resolveLatexTextAccent, resolveLatexTextSymbol } from '../../utils';
import { isMacroNode, isWhitespaceOrCommentNode, stringNodeContent } from '../visit-utils';
import { readAstCommandArguments, readAstCommandNodeArguments, type AstRenderContext, type AstRenderInput, type AstRenderRule } from './index';

const OMITTED_ARGUMENT_MACROS = new Map<string, number>(Object.entries(LATEX_OMITTED_ARGUMENT_COMMANDS));
const LAYOUT_ASSIGNMENT_MACROS = new Set(['baselineskip', 'parskip', 'parindent']);
const LAYOUT_BREAK_MACROS = new Set<string>(LATEX_LAYOUT_BREAK_COMMANDS);
const LAYOUT_SWITCH_MACROS = new Set<string>(LATEX_LAYOUT_SWITCH_COMMANDS);
const UNBRACED_SPACING_MACROS = new Set<string>(LATEX_UNBRACED_SPACING_COMMANDS);
const LEADING_DIMENSION_PATTERN = new RegExp(`^${LATEX_DIMENSION_SOURCE}`);
const OMITTED_MACROS = new Set<string>(LATEX_PREVIEW_OMITTED_COMMANDS);
const INLINE_NOTE_MACROS = new Set<string>(LATEX_INLINE_NOTE_COMMANDS);
const TEXT_ACCENT_MACROS = new Set(Object.keys(LATEX_TEXT_ACCENTS));
const TRANSPARENT_ENVIRONMENTS = new Set<string>(TRANSPARENT_CONTAINER_ENVIRONMENTS);

function renderTextAccent(command: string, input: AstRenderInput, context: AstRenderContext) {
    const args = readAstCommandArguments(input);
    const grouped = args.requiredArgs[0];
    if (grouped !== undefined) {
        const accent = resolveLatexTextAccent(command, grouped);
        return accent ? { html: context.escapeHtml(accent), consumedNodes: args.consumedNodes } : undefined;
    }

    let cursor = input.index + 1;
    while (isWhitespaceOrCommentNode(input.siblings[cursor])) { cursor++; }
    const node = input.siblings[cursor];
    const text = stringNodeContent(node) ?? (isMacroNode(node) && /^[ij]$/.test(node.content) ? node.content : '');
    const [base = '', ...rest] = Array.from(text);
    const accent = resolveLatexTextAccent(command, base);
    return accent ? {
        html: context.escapeHtml(accent + rest.join('')),
        consumedNodes: cursor - input.index + 1
    } : undefined;
}

export const AST_COMPATIBILITY_RULE: AstRenderRule = (input, context) => {
    if (!isMacroNode(input.node)) {
        return undefined;
    }

    if (input.node.content === 'appendix' || OMITTED_MACROS.has(input.node.content)) {
        return { html: '' };
    }
    if (input.node.content === 'begin' || input.node.content === 'end') {
        const args = readAstCommandArguments(input);
        if (TRANSPARENT_ENVIRONMENTS.has(args.requiredArgs[0])) {
            return { html: '', consumedNodes: args.consumedNodes };
        }
    }
    if (LAYOUT_SWITCH_MACROS.has(input.node.content)) {
        return {
            html: '',
            consumedNodes: readAstCommandArguments(input, 0).consumedNodes
        };
    }
    if (LAYOUT_BREAK_MACROS.has(input.node.content)) {
        return { html: '\n\n', consumedNodes: readAstCommandArguments(input, 0).consumedNodes };
    }
    if (UNBRACED_SPACING_MACROS.has(input.node.content)) {
        let cursor = input.index + 1;
        while (isWhitespaceOrCommentNode(input.siblings[cursor])) { cursor++; }
        const content = stringNodeContent(input.siblings[cursor]);
        const dimension = content && LEADING_DIMENSION_PATTERN.exec(content);
        if (dimension) {
            return {
                html: (input.node.content === 'vskip' ? '\n\n' : '') + input.renderSource(content.slice(dimension[0].length)),
                consumedNodes: cursor - input.index + 1
            };
        }
    }
    const omittedArgumentCount = OMITTED_ARGUMENT_MACROS.get(input.node.content);
    if (omittedArgumentCount !== undefined) {
        return { html: '', consumedNodes: readAstCommandArguments(input, omittedArgumentCount).consumedNodes };
    }
    if (LAYOUT_ASSIGNMENT_MACROS.has(input.node.content)) {
        return { html: '', consumedNodes: readAstCommandArguments(input).consumedNodes };
    }
    if (input.node.content === 'noindent') {
        return { html: '<span class="no-indent-marker"></span>' };
    }
    const textSymbol = resolveLatexTextSymbol(input.node.content);
    if (textSymbol) {
        return { html: context.escapeHtml(textSymbol) };
    }
    if (TEXT_ACCENT_MACROS.has(input.node.content)) {
        return renderTextAccent(input.node.content, input, context);
    }
    const wrapper = LATEX_CONTENT_WRAPPER_COMMANDS[input.node.content];
    if (wrapper) {
        const args = readAstCommandNodeArguments(input, wrapper.requiredArgs, wrapper.argumentOrder);
        return {
            html: context.escapeHtml(wrapper.prefix ?? '')
                + input.renderChildren(args.requiredArgs[wrapper.contentArg] ?? [])
                + context.escapeHtml(wrapper.suffix ?? ''),
            consumedNodes: args.consumedNodes
        };
    }
    if (input.node.content === 'ensuremath') {
        const args = readAstCommandArguments(input);
        return {
            html: context.renderMath(args.requiredArgs[0] ?? '', false),
            consumedNodes: args.consumedNodes
        };
    }
    if (['Rmnum', 'rmnum', 'romannumeral'].includes(input.node.content)) {
        const args = readAstCommandArguments(input);
        const value = formatLatexRomanNumeral(input.node.content, args.requiredArgs[0] ?? '');
        return value !== undefined
            ? { html: context.escapeHtml(value), consumedNodes: args.consumedNodes }
            : undefined;
    }
    if (input.node.content === '\\') {
        return { html: '<br/>' };
    }
    if (['%', '#', '&', '$', '{', '}'].includes(input.node.content)) {
        return { html: context.escapeHtml(input.node.content) };
    }
    if (INLINE_NOTE_MACROS.has(input.node.content)) {
        const args = readAstCommandArguments(input);
        return {
            html: renderInlineNoteHtml(input.renderChildren(args.requiredArgNodes[0] ?? [])),
            consumedNodes: args.consumedNodes
        };
    }
    const siunitxArgCount = siunitxArgumentCount(input.node.content);
    if (siunitxArgCount > 0) {
        const args = readAstCommandArguments(input, siunitxArgCount);
        return {
            html: context.renderMath(siunitxMathSource(input.node.content, args.requiredArgs) ?? '', false),
            consumedNodes: args.consumedNodes
        };
    }
    return undefined;
};
