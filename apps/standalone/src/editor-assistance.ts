import type { Extension } from '@codemirror/state';
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser } from '@codemirror/language';
import { tags } from '@lezer/highlight';

const { stex } = require('@codemirror/legacy-modes/mode/stex') as { stex: StreamParser<unknown> };

export interface LatexCompletionData {
    labels: readonly string[];
    citationKeys: readonly string[];
    projectPaths: readonly string[];
    macros: readonly string[];
}

export type LatexCompletionDataProvider = () => LatexCompletionData;

const REF_COMMANDS = ['ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref'];
const CITE_COMMANDS = ['cite', 'citep', 'citet', 'citeyear', 'citeauthor', 'parencite', 'textcite'];
const INPUT_COMMANDS = ['input', 'include'];
const FILE_COMMANDS = [...INPUT_COMMANDS, 'includegraphics'];

const snaptexLatexHighlightStyle = HighlightStyle.define([
    { tag: tags.keyword, color: 'var(--snaptex-cm-keyword)', fontWeight: '700' },
    { tag: tags.atom, color: 'var(--snaptex-cm-atom)', fontWeight: '700' },
    { tag: tags.operator, color: 'var(--snaptex-cm-operator)', fontWeight: '700' },
    { tag: tags.bracket, color: 'var(--snaptex-cm-bracket)' },
    { tag: tags.string, color: 'var(--snaptex-cm-string)' },
    { tag: tags.variableName, color: 'var(--snaptex-cm-variable)' },
    { tag: tags.macroName, color: 'var(--snaptex-cm-macro)', fontWeight: '700' },
    { tag: tags.labelName, color: 'var(--snaptex-cm-label)' },
    { tag: tags.comment, color: 'var(--snaptex-cm-comment)', fontStyle: 'italic' },
    { tag: tags.meta, color: 'var(--snaptex-cm-meta)' },
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

export function snaptexLatexCompletionSource(provider: LatexCompletionDataProvider) {
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

export function createLatexEditorExtensions(provider: LatexCompletionDataProvider): Extension[] {
    return [
        StreamLanguage.define(stex),
        syntaxHighlighting(snaptexLatexHighlightStyle),
        autocompletion({
            override: [snaptexLatexCompletionSource(provider)]
        })
    ];
}
