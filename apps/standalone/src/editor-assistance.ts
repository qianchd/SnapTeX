import { Prec, type Extension, type StateCommand } from '@codemirror/state';
import { autocompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { insertNewlineAndIndent, insertNewlineKeepIndent } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';

// Keep the third-party LaTeX package behind a narrow boundary so its ESM-oriented declarations
// do not leak into SnapTeX's CommonJS test and extension build.
const codemirrorLatex = require('codemirror-lang-latex') as {
    latex(config?: {
        autoCloseTags?: boolean;
        enableLinting?: boolean;
        enableTooltips?: boolean;
        enableAutocomplete?: boolean;
        autoCloseBrackets?: boolean;
    }): Extension;
    latexCompletionSource(autoCloseTagsEnabled: boolean): CompletionSource;
};

export interface LatexCompletionData {
    labels: readonly string[];
    citationKeys: readonly string[];
    projectPaths: readonly string[];
    macros: readonly string[];
}

type LatexCompletionDataProvider = () => LatexCompletionData;

const REF_COMMANDS = ['ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref'];
const CITE_COMMANDS = ['cite', 'citep', 'citet', 'citeyear', 'citeauthor', 'parencite', 'textcite'];
const INPUT_COMMANDS = ['input', 'include'];
const FILE_COMMANDS = [...INPUT_COMMANDS, 'includegraphics'];
const COMMON_LATEX_COMPLETION_SOURCE = codemirrorLatex.latexCompletionSource(true);
const LATEX_LANGUAGE_SUPPORT = codemirrorLatex.latex({
    autoCloseTags: true,
    autoCloseBrackets: true,
    enableTooltips: true,
    enableAutocomplete: false,
    enableLinting: false
});
const BEGIN_ENVIRONMENT_LINE = /\\begin\{([^}\n]+)\}(?:\[[^\]\n]*\])?\s*(?:%.*)?$/;
const INDENT_ON_ENTER_ENVIRONMENTS = new Set([
    'itemize', 'enumerate', 'description',
    'algorithmic',
    'proof', 'theorem', 'lemma', 'proposition', 'corollary', 'definition', 'remark',
    'align', 'align*', 'equation', 'equation*', 'gather', 'gather*'
]);

const snaptexLatexHighlightStyle = HighlightStyle.define([
    { tag: tags.keyword, color: 'var(--snaptex-cm-keyword)', fontWeight: '700' },
    { tag: tags.atom, color: 'var(--snaptex-cm-atom)', fontWeight: '700' },
    { tag: tags.operator, color: 'var(--snaptex-cm-operator)', fontWeight: '700' },
    { tag: tags.bracket, color: 'var(--snaptex-cm-bracket)' },
    { tag: tags.string, color: 'var(--snaptex-cm-string)' },
    { tag: tags.variableName, color: 'var(--snaptex-cm-variable)' },
    { tag: [tags.macroName, tags.heading, tags.definitionKeyword], color: 'var(--snaptex-cm-macro)', fontWeight: '700' },
    { tag: tags.className, color: 'var(--snaptex-cm-atom)', fontWeight: '700' },
    { tag: tags.labelName, color: 'var(--snaptex-cm-label)' },
    { tag: tags.quote, color: 'var(--snaptex-cm-label)' },
    { tag: tags.comment, color: 'var(--snaptex-cm-comment)', fontStyle: 'italic' },
    { tag: [tags.meta, tags.processingInstruction], color: 'var(--snaptex-cm-meta)' },
    { tag: tags.strong, color: 'var(--snaptex-cm-string)', fontWeight: '700' },
    { tag: tags.emphasis, color: 'var(--snaptex-cm-string)', fontStyle: 'italic' },
    { tag: tags.monospace, color: 'var(--snaptex-cm-string)' },
    { tag: tags.invalid, color: 'var(--snaptex-cm-invalid)', textDecoration: 'underline wavy var(--snaptex-cm-invalid)' }
]);

function uniqueSorted(values: readonly string[]): string[] {
    return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function commandArgMatch(context: CompletionContext, commands: readonly string[]): { from: number; command: string } | undefined {
    const before = context.state.sliceDoc(Math.max(0, context.pos - 160), context.pos);
    const commandPattern = commands.map(command => command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const match = before.match(new RegExp(`\\\\(${commandPattern})\\*?(?:\\[[^\\]]*\\]){0,2}\\{([^{}]*)$`));
    if (!match) { return undefined; }
    return {
        command: match[1],
        from: context.pos - match[2].length
    };
}

function option(label: string, type: Completion['type']): Completion {
    return { label, type };
}

function pathOptions(paths: readonly string[], command: string): Completion[] {
    const texOnly = INPUT_COMMANDS.includes(command);
    return uniqueSorted(paths)
        .map(path => path.replace(/^\//, ''))
        .filter(path => texOnly ? /\.tex$/i.test(path) : /\.(?:pdf|png|jpe?g|gif|svg|webp|bmp)$/i.test(path))
        .map(path => option(path, 'file'));
}

function snaptexLatexCompletionSource(provider: LatexCompletionDataProvider) {
    return (context: CompletionContext): CompletionResult | null => {
        const data = provider();

        const refMatch = commandArgMatch(context, REF_COMMANDS);
        if (refMatch) {
            return {
                from: refMatch.from,
                options: uniqueSorted(data.labels).map(label => option(label, 'constant')),
                validFor: /^[^{}]*$/
            };
        }

        const citeMatch = commandArgMatch(context, CITE_COMMANDS);
        if (citeMatch) {
            return {
                from: citeMatch.from,
                options: uniqueSorted(data.citationKeys).map(key => option(key, 'constant')),
                validFor: /^[^{}]*$/
            };
        }

        const inputMatch = commandArgMatch(context, FILE_COMMANDS);
        if (inputMatch) {
            return {
                from: inputMatch.from,
                options: pathOptions(data.projectPaths, inputMatch.command),
                validFor: /^[^{}]*$/
            };
        }

        const macro = context.matchBefore(/\\[A-Za-z@]*$/);
        if (macro) {
            return {
                from: macro.from,
                options: uniqueSorted(data.macros.map(name => name.startsWith('\\') ? name : `\\${name}`))
                    .map(name => option(name, 'function')),
                validFor: /^\\[A-Za-z@]*$/
            };
        }

        return null;
    };
}

export function snaptexLatexCompletionSources(provider: LatexCompletionDataProvider): CompletionSource[] {
    return [
        snaptexLatexCompletionSource(provider),
        COMMON_LATEX_COMPLETION_SOURCE
    ];
}

export const snaptexInsertNewline: StateCommand = target => {
    const ranges = target.state.selection.ranges;
    if (ranges.length === 1 && ranges[0].empty) {
        const range = ranges[0];
        const line = target.state.doc.lineAt(range.from);
        const prefix = line.text.slice(0, range.from - line.from);
        const match = prefix.match(BEGIN_ENVIRONMENT_LINE);
        if (match && INDENT_ON_ENTER_ENVIRONMENTS.has(match[1])) {
            const currentIndentation = line.text.match(/^\s*/)?.[0] ?? '';
            const innerIndentation = `${currentIndentation}  `;
            const insert = `\n${innerIndentation}\n${currentIndentation}\\end{${match[1]}}`;
            target.dispatch(target.state.update({
                changes: { from: range.from, insert },
                selection: { anchor: range.from + innerIndentation.length + 1 }
            }));
            return true;
        }
    }

    const shouldUseLanguageIndent = ranges.some(range => {
        if (!range.empty) { return false; }
        const line = target.state.doc.lineAt(range.from);
        const match = line.text.slice(0, range.from - line.from).match(BEGIN_ENVIRONMENT_LINE);
        return !!match && INDENT_ON_ENTER_ENVIRONMENTS.has(match[1]);
    });
    return shouldUseLanguageIndent ? insertNewlineAndIndent(target) : insertNewlineKeepIndent(target);
};

export function createLatexEditorExtensions(provider: LatexCompletionDataProvider): Extension[] {
    return [
        Prec.highest(keymap.of([
            { key: 'Enter', run: snaptexInsertNewline, shift: snaptexInsertNewline }
        ])),
        LATEX_LANGUAGE_SUPPORT,
        syntaxHighlighting(snaptexLatexHighlightStyle),
        autocompletion({
            override: snaptexLatexCompletionSources(provider)
        })
    ];
}
