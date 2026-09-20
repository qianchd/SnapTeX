import { formatLatexRomanNumeral } from '../../utils';
import { REGEX_STR } from '../../patterns';
import { normalizeMathEnvironmentForKatex, renderNumberedEquationHtml } from '../../rule-helpers';
import type { SnaptexAstNode } from '../types';
import { parseMathWithLoadedParser } from '../parse';
import { astNodesRange, environmentName, getSourcePosition, isMacroNode, visitLatexAst } from '../visit-utils';
import {
    AST_REF_MACROS,
    readAstCommandArguments,
    type AstMathRuleInput,
    type AstMathRule,
    type AstMathRuleResult,
    type AstRenderContext,
    type AstRenderRule
} from './index';

const MATH_ENVIRONMENTS = new Set(REGEX_STR.MATH_ENVS.split('|'));

function isFollowedByText(input: Parameters<AstRenderRule>[0]): boolean {
    for (let index = input.index + 1; index < input.siblings.length; index++) {
        const node = input.siblings[index];
        if (node.type === 'whitespace') {
            continue;
        }
        return node.type !== 'parbreak';
    }
    return false;
}

interface MathHtmlPlaceholder {
    token: string;
    html: string;
    text: string;
}

const AST_MBOX_MATH_RULE: AstMathRule = {
    commands: ['mbox'],
    apply: () => ({ replacement: '\\text' })
};

const AST_ROMAN_NUMERAL_MATH_RULE: AstMathRule = {
    commands: ['Rmnum', 'rmnum', 'romannumeral'],
    apply: input => {
        const replacement = formatLatexRomanNumeral(input.node.content, input.arguments.requiredArgs[0] ?? '');
        return replacement === undefined
            ? undefined
            : { replacement, consumedNodes: input.arguments.consumedNodes };
    }
};

const AST_REF_MATH_RULE: AstMathRule = {
    commands: [...AST_REF_MACROS],
    apply: (input, context) => {
        const labels = (input.arguments.requiredArgs[0] ?? '').split(',').map(key => key.trim()).filter(Boolean);
        if (labels.length === 0) { return undefined; }

        const type = input.node.content === 'eqref' ? 'eqref' : 'ref';
        return {
            consumedNodes: input.arguments.consumedNodes,
            replacement: '',
            placeholder: {
                html: context.renderRef(labels, type),
                text: type === 'eqref' ? '(?)' : '?'
            }
        };
    }
};

const AST_LABEL_MATH_RULE: AstMathRule = {
    commands: ['label'],
    apply: (input, context) => {
        const label = input.arguments.requiredArgs[0]?.trim();
        return label
            ? { replacement: '', consumedNodes: input.arguments.consumedNodes, afterHtml: context.renderLabel(label) }
            : undefined;
    }
};

export const DEFAULT_AST_MATH_RULES: readonly AstMathRule[] = [
    AST_MBOX_MATH_RULE,
    AST_ROMAN_NUMERAL_MATH_RULE,
    AST_REF_MATH_RULE,
    AST_LABEL_MATH_RULE
];

interface MathSourceEdit {
    start: number;
    end: number;
    replacement: string;
    placeholder?: MathHtmlPlaceholder;
    afterHtml?: string;
}

interface PreparedMathSource {
    source: string;
    placeholders: MathHtmlPlaceholder[];
    hiddenHtml: string;
}

function mathNodeContent(source: string, type: string, envName?: string): string {
    const delimiters = type === 'inlinemath'
        ? [['$', '$'], ['\\(', '\\)']]
        : type === 'displaymath'
            ? [['$$', '$$'], ['\\[', '\\]']]
            : envName
                ? [[`\\begin{${envName}}`, `\\end{${envName}}`]]
                : [];
    const match = delimiters.find(([open, close]) => source.startsWith(open) && source.endsWith(close));
    return match ? source.slice(match[0].length, -match[1].length) : source;
}

function sourceEdit(
    nodes: readonly SnaptexAstNode[],
    index: number,
    consumedNodes: number,
    replacement: string
): MathSourceEdit | undefined {
    const range = astNodesRange(nodes.slice(index, index + consumedNodes));
    return range ? { ...range, replacement } : undefined;
}

function hasRegisteredMathCommand(node: SnaptexAstNode, rules: readonly AstMathRule[]): boolean {
    if (!Array.isArray(node.content)) { return false; }

    let needed = false;
    visitLatexAst({ type: 'root', content: [...node.content] }, child => {
        needed ||= isMacroNode(child) && hasMathRule(child.content, rules);
    });
    return needed;
}

function hasMathRule(command: string, rules: readonly AstMathRule[]): boolean {
    return rules.some(rule => rule.commands.includes(command));
}

function prepareMathSource(
    source: string,
    nodes: readonly SnaptexAstNode[],
    rules: readonly AstMathRule[],
    context: AstRenderContext
): PreparedMathSource {
    const edits: MathSourceEdit[] = [];

    visitLatexAst({ type: 'root', content: [...nodes] }, (node, index, siblings) => {
        if (!isMacroNode(node) || !hasMathRule(node.content, rules)) { return; }
        const ruleInput: AstMathRuleInput = {
            node,
            siblings,
            index,
            arguments: readAstCommandArguments({ node, siblings, index }),
            sourceContent: childNodes => {
                const range = astNodesRange(childNodes);
                return range ? source.slice(range.start, range.end) : '';
            }
        };
        let result: AstMathRuleResult | undefined;
        for (const rule of rules) {
            if (rule.commands.includes(node.content) && (result = rule.apply(ruleInput, context))) { break; }
        }
        if (!result) { return; }

        const placeholder = result.placeholder
            ? { token: `SNAPTEXMATHHTML${edits.length}`, ...result.placeholder }
            : undefined;
        const edit = sourceEdit(
            siblings,
            index,
            result.consumedNodes ?? 1,
            placeholder ? `\\text{${placeholder.token}}` : result.replacement
        );
        if (!edit) { return; }

        edits.push({ ...edit, placeholder, afterHtml: result.afterHtml });
    });
    const disjointEdits: MathSourceEdit[] = [];
    for (const edit of edits.sort((left, right) => left.start - right.start || right.end - left.end)) {
        if (edit.start >= (disjointEdits.at(-1)?.end ?? 0)) { disjointEdits.push(edit); }
    }

    let transformed = source;
    for (const edit of disjointEdits.reverse()) {
        if (edit.start >= 0 && edit.end >= edit.start && edit.end <= transformed.length) {
            transformed = transformed.slice(0, edit.start) + edit.replacement + transformed.slice(edit.end);
        }
    }

    return {
        source: transformed,
        placeholders: disjointEdits.flatMap(edit => edit.placeholder ? [edit.placeholder] : []),
        hiddenHtml: disjointEdits.map(edit => edit.afterHtml ?? '').join('')
    };
}

function applyMathHtmlPlaceholders(html: string, placeholders: readonly MathHtmlPlaceholder[]): string {
    if (placeholders.length === 0) {
        return html;
    }

    const marker = '<span class="katex-html"';
    const markerIndex = html.indexOf(marker);
    const replaceTokens = (input: string, field: 'html' | 'text') => placeholders.reduce(
        (current, placeholder) => current.split(placeholder.token).join(placeholder[field]),
        input
    );

    if (markerIndex === -1) {
        return replaceTokens(html, 'html');
    }
    return replaceTokens(html.slice(0, markerIndex), 'text') + replaceTokens(html.slice(markerIndex), 'html');
}

function wrapSourceAnchor(html: string, node: Parameters<AstRenderRule>[0]['node']): string {
    const position = getSourcePosition(node);
    if (!position) {
        return html;
    }
    return `<span data-sn-src-start="${position.start.offset}" data-sn-src-end="${position.end.offset}">${html}</span>`;
}

export const AST_MATH_RULE: AstRenderRule = (input, context) => {
    const node = input.node;
    const envName = environmentName(node);
    if (node.type !== 'inlinemath' && node.type !== 'displaymath' && node.type !== 'mathenv'
        && (!envName || !MATH_ENVIRONMENTS.has(envName.replace(/\*$/, '')))) {
        return undefined;
    }
    const displayMode = node.type !== 'inlinemath';
    const rawContent = mathNodeContent(context.sourceSlice(node), node.type, envName);
    const mathRules = context.astMathRules ?? DEFAULT_AST_MATH_RULES;
    const mathAst = hasRegisteredMathCommand(node, mathRules) ? parseMathWithLoadedParser(rawContent) : undefined;
    const prepared = prepareMathSource(rawContent, mathAst ?? [], mathRules, context);
    let tex = prepared.source.trim();

    tex = normalizeMathEnvironmentForKatex(tex, envName);

    const mathHtml = wrapSourceAnchor(
        applyMathHtmlPlaceholders(context.renderMath(tex, displayMode), prepared.placeholders),
        node
    );
    const numbered = envName !== undefined && !envName.endsWith('*');
    const html = numbered
        ? renderNumberedEquationHtml(mathHtml, '(<span class="sn-cnt" data-type="eq"></span>)', prepared.hiddenHtml)
        : `${mathHtml}${prepared.hiddenHtml}`;
    return {
        html: html + (displayMode && isFollowedByText(input) ? '<span class="no-indent-marker"></span>' : '')
    };
};
