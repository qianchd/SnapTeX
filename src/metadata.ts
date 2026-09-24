import { AffiliationMetadata, AuthorMetadata, LatexMacroAlias, LatexMacroDefinition, MetadataExtractionResult, MetadataExtractor, MetadataResult, PreambleData, PreambleEnvironmentDefinition, PreambleMetadata, TextRange } from './types';
import { LATEX_CONTENT_WRAPPER_COMMANDS, LATEX_DECLARATION_STYLE_COMMANDS, REGEX_STR, TIKZ_GLOBAL_COMMANDS } from './patterns';
import { countLatexMacroArguments, escapeRegExp, findCommand, latexColorModelToCss, maskLatexFalseBranches, readLatexCommandAt, readLatexGroup, resolveLatexTextTransforms, skipLatexWhitespace, stripLatexComments } from './utils';

type MacroDefinitionCommand = 'newcommand' | 'renewcommand' | 'providecommand' | 'algnewcommand' | 'def' | 'gdef'
    | 'DeclareMathOperator' | 'DeclarePairedDelimiter' | 'DeclarePairedDelimiterX';
type AuthorExtraction = { authors: AuthorMetadata[]; affiliations: AffiliationMetadata[] };

/**
 * Preamble definition scanner.
 *
 * Examples:
 *   \newcommand{\vect}[1]{\mathbf{#1}}
 *   \DeclareMathOperator{\rank}{rank}
 *   \usetikzlibrary{calc}
 *
 * These definitions are removed from body text and routed to KaTeX/TikZJax
 * metadata so preview blocks do not render the raw preamble commands.
 */
interface MacroDefinitionHeader {
    command: MacroDefinitionCommand;
    name: string;
    star: boolean;
    argCount: number;
    defaultArgument?: string;
    body: {
        content: string;
        start: number;
    };
}

function readMacroName(text: string, index: number): { name: string; end: number } | undefined {
    index = skipLatexWhitespace(text, index);

    const grouped = readLatexGroup(text, index, { delimiter: 'brace', skipWhitespace: false });
    if (grouped) {
        const name = grouped.content.trim();
        return /^\\[a-zA-Z0-9@]+$/.test(name) ? { name, end: grouped.end } : undefined;
    }

    if (text[index] !== '\\') { return undefined; }
    let end = index + 1;
    while (end < text.length && /[a-zA-Z0-9@]/.test(text[end])) { end++; }
    const name = text.substring(index, end);
    return /^\\[a-zA-Z0-9@]+$/.test(name) ? { name, end } : undefined;
}

function readMacroDefinitionHeader(fullDef: string): MacroDefinitionHeader | undefined {
    const commandMatch = /^\\(newcommand|renewcommand|providecommand|algnewcommand|g?def|DeclareMathOperator|DeclarePairedDelimiterX?)(\*)?/.exec(fullDef);
    if (!commandMatch) { return undefined; }

    const command = commandMatch[1] as MacroDefinitionCommand;
    const star = commandMatch[2] === '*';
    const macroName = readMacroName(fullDef, commandMatch[0].length);
    if (!macroName) { return undefined; }

    let index = macroName.end;
    let argCount = 0;
    let defaultArgument: string | undefined;

    if (command === 'DeclarePairedDelimiter' || command === 'DeclarePairedDelimiterX') {
        if (command === 'DeclarePairedDelimiterX') {
            const argCountGroup = readLatexGroup(fullDef, index, { delimiter: 'bracket' });
            if (!argCountGroup || !/^\d+$/.test(argCountGroup.content.trim())) { return undefined; }
            argCount = parseInt(argCountGroup.content.trim(), 10);
            index = argCountGroup.end;
        } else {
            argCount = 1;
        }
        const left = readLatexGroup(fullDef, index);
        const right = left && readLatexGroup(fullDef, left.end);
        const content = command === 'DeclarePairedDelimiterX' && right
            ? readLatexGroup(fullDef, right.end)
            : undefined;
        if (!left || !right || (command === 'DeclarePairedDelimiterX' && !content)) { return undefined; }
        return {
            command,
            name: macroName.name,
            star,
            argCount,
            body: {
                content: `\\left${left.content}${content?.content ?? '#1'}\\right${right.content}`,
                start: 0
            }
        };
    }

    if (command === 'newcommand' || command === 'renewcommand' || command === 'providecommand' || command === 'algnewcommand') {
        const argCountGroup = readLatexGroup(fullDef, index, { delimiter: 'bracket' });
        if (argCountGroup && /^\d+$/.test(argCountGroup.content.trim())) {
            argCount = parseInt(argCountGroup.content.trim(), 10);
            index = argCountGroup.end;

            const defaultArgGroup = readLatexGroup(fullDef, index, { delimiter: 'bracket' });
            if (defaultArgGroup) {
                defaultArgument = defaultArgGroup.content;
                index = defaultArgGroup.end;
            }
        }
    } else if (command === 'def' || command === 'gdef') {
        const bodyIndex = fullDef.indexOf('{', index);
        if (bodyIndex === -1) { return undefined; }
        index = bodyIndex;
    }

    const body = readLatexGroup(fullDef, index, { delimiter: 'brace' });
    if (!body) { return undefined; }

    return {
        command,
        name: macroName.name,
        star,
        argCount: Math.max(argCount, countLatexMacroArguments(body.content)),
        defaultArgument,
        body: {
            content: body.content,
            start: body.start
        }
    };
}

/**
 * Converts simple \newcommand definitions to \def syntax accepted by TikZJax.
 */
function transpileToDef(header: MacroDefinitionHeader, fullDef: string): string {
    if (header.command === 'DeclarePairedDelimiter' || header.command === 'DeclarePairedDelimiterX') {
        const args = Array.from({ length: header.argCount }, (_unused, index) => `#${index + 1}`).join('');
        return `\\def${header.name}${args}{${header.body.content}}`;
    }
    if (!header.command.endsWith('newcommand') || header.defaultArgument !== undefined) {return fullDef;}

    const args = Array.from({ length: header.argCount }, (_unused, index) => `#${index + 1}`).join('');
    return `\\def${header.name}${args}${fullDef.substring(header.body.start)}`;
}

interface DefinitionRecord extends TextRange {
    command: string;
    fullDef: string;
}

function consumeControlSequence(text: string, index: number): number {
    if (text[index] !== '\\') { return index; }
    let i = index + 1;
    while (i < text.length && /[a-zA-Z@]/.test(text[i])) { i++; }
    return i > index + 1 ? i : index + 2;
}

function findDefinitionEnd(text: string, tokenEndIndex: number): number {
    let i = tokenEndIndex;
    let consumedGroup = false;

    while (i < text.length) {
        const beforeWhitespace = i;
        i = skipLatexWhitespace(text, i);
        const char = text[i];

        if (char === '[') {
            const group = readLatexGroup(text, i, { delimiter: 'bracket', skipWhitespace: false });
            if (!group) { return -1; }
            i = group.end;
            continue;
        }

        if (char === '{') {
            const group = readLatexGroup(text, i, { delimiter: 'brace', skipWhitespace: false });
            if (!group) { return -1; }
            consumedGroup = true;
            i = group.end;
            continue;
        }

        if (!consumedGroup && char === '\\') {
            i = consumeControlSequence(text, i);
            continue;
        }

        if (!consumedGroup) {
            i++;
            continue;
        }

        return beforeWhitespace;
    }

    return consumedGroup ? i : -1;
}

function findLetDefinitionEnd(text: string, tokenEndIndex: number): number {
    const skipSpace = (index: number) => {
        while (text[index] === ' ' || text[index] === '\t') { index++; }
        return index;
    };
    let index = skipSpace(tokenEndIndex);
    if (text[index] !== '\\') { return -1; }
    index = skipSpace(consumeControlSequence(text, index));
    if (text[index] === '=') { index = skipSpace(index + 1); }
    if (index >= text.length || /[\r\n]/.test(text[index])) { return -1; }
    return text[index] === '\\' ? consumeControlSequence(text, index) : index + 1;
}

function blankOutRanges(text: string, ranges: TextRange[]): string {
    if (ranges.length === 0) { return text; }

    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    let result = "";
    let cursor = 0;

    for (const range of sorted) {
        const start = Math.max(cursor, range.start);
        const end = Math.max(start, range.end);
        result += text.substring(cursor, start);
        result += text.substring(start, end).replace(/[^\r\n]/g, ' ');
        cursor = end;
    }

    result += text.substring(cursor);
    return result;
}

function collectDefinitions(text: string): DefinitionRecord[] {
    const records: DefinitionRecord[] = [];
    const defRegex = new RegExp(`\\\\(${REGEX_STR.PREAMBLE_DEFINITIONS}|let)\\*?(?=\\s|\\\\|\\{|\\[|$)`, 'g');

    let defMatch;
    while ((defMatch = defRegex.exec(text)) !== null) {
        const start = defMatch.index;
        const end = defMatch[1] === 'let'
            ? findLetDefinitionEnd(text, start + defMatch[0].length)
            : findDefinitionEnd(text, start + defMatch[0].length);
        if (end === -1) { continue; }

        records.push({ start, end, command: defMatch[1], fullDef: text.substring(start, end) });
        defRegex.lastIndex = end;
    }

    return records;
}

export function stripLatexDefinitions(text: string): string {
    return blankOutRanges(text, collectDefinitions(text));
}

function extractKatexMacro(header: MacroDefinitionHeader): { name: string; definition: LatexMacroDefinition } | undefined {
    const rawDefinition = header.command === 'DeclareMathOperator'
        ? header.body.content.trim()
        : header.body.content;
    const definition = header.command === 'DeclareMathOperator'
        ? (header.star ? `\\operatorname*{${rawDefinition}}` : `\\operatorname{${rawDefinition}}`)
        : rawDefinition;

    return {
        name: header.name,
        definition: {
            body: definition,
            argumentCount: header.argCount,
            ...(!isDeclarativeMacroBody(definition) ? { textExpandable: false } : {}),
            ...(header.defaultArgument !== undefined ? { defaultArgument: header.defaultArgument } : {}),
            ...(/^DeclarePairedDelimiter/.test(header.command) ? { allowStar: true } : {})
        }
    };
}

function isDeclarativeMacroBody(body: string): boolean {
    if (/\\(?:if\w*|else|fi|let|[egx]?def|global|csname|endcsname|expandafter|penalty)\b/.test(body)) {
        return false;
    }
    return Array.from(body.matchAll(/\\([a-zA-Z@]+)/g), match => match[1])
        .every(name => !name.includes('@') || LATEX_CONTENT_WRAPPER_COMMANDS[name] !== undefined);
}

function readMacroAlias(fullDefinition: string): Pick<LatexMacroAlias, 'name' | 'target'> | undefined {
    const match = /^\\let\s*(\\(?:[a-zA-Z@]+|.))\s*=?\s*(\\(?:[a-zA-Z@]+|.)|[^\s])/.exec(fullDefinition);
    return match ? { name: match[1], target: match[2] } : undefined;
}

function extractColorDefinition(fullDefinition: string): { name: string; color: string } | undefined {
    const call = readLatexCommandAt(fullDefinition, 0, {
        name: 'definecolor',
        requiredArgs: 3,
        skipWhitespace: false
    });
    if (!call) { return undefined; }

    const name = call.requiredArgs[0].content.trim();
    const color = latexColorModelToCss(call.requiredArgs[1].content, call.requiredArgs[2].content);
    return name && color ? { name, color } : undefined;
}

function readEnvironmentBoundary(text: string, command: 'begin' | 'end'): { target: string; options?: string } | undefined {
    const call = readLatexCommandAt(text, 0, { name: command, requiredArgs: 1 });
    if (!call) { return undefined; }

    const target = call.requiredArgs[0].content.trim();
    const options = command === 'begin'
        ? readLatexGroup(text, call.end, { delimiter: 'bracket' })
        : undefined;
    const end = skipLatexWhitespace(text, options?.end ?? call.end);
    return end === text.length && /^[a-zA-Z@][a-zA-Z0-9@*.-]*$/.test(target)
        ? { target, ...(options ? { options: options.content } : {}) }
        : undefined;
}

function readStyleEnvironment(opening: string, closing: string): string | undefined {
    if (closing.replace(/\\ignorespacesafterend\b/g, '').trim()) { return undefined; }
    const declaration = opening.replace(/\\ignorespaces\b/g, '').trim();
    const color = readLatexCommandAt(declaration, 0, { name: 'color', optionalArgs: 1, requiredArgs: 1 });
    if (color?.end === declaration.length) { return declaration; }

    return LATEX_DECLARATION_STYLE_COMMANDS.some(name =>
        readLatexCommandAt(declaration, 0, { name })?.end === declaration.length
    ) ? declaration : undefined;
}

function readWrappedListEnvironmentAlias(opening: string, closing: string): Extract<PreambleEnvironmentDefinition, { kind: 'alias' }> | undefined {
    const beginMatch = /\\begin\s*\{([a-zA-Z@][a-zA-Z0-9@*.-]*)\}/.exec(opening);
    const endMatch = /\\end\s*\{([a-zA-Z@][a-zA-Z0-9@*.-]*)\}/.exec(closing);
    if (!beginMatch || !endMatch || beginMatch[1] !== endMatch[1]
        || !new RegExp(`^(?:${REGEX_STR.LIST_ENVS})$`).test(beginMatch[1])
        || /\\begin\s*\{/.test(opening.slice(beginMatch.index + beginMatch[0].length))
        || /\\end\s*\{/.test(closing.slice(endMatch.index + endMatch[0].length))) {
        return undefined;
    }
    return { kind: 'alias', target: beginMatch[1], opening, closing };
}

function extractEnvironmentDefinition(fullDefinition: string): { name: string; definition: PreambleEnvironmentDefinition } | undefined {
    const tcolorbox = /^\\(?:new|renew|provide)tcolorbox/.exec(fullDefinition);
    if (tcolorbox) {
        const name = readLatexGroup(fullDefinition, tcolorbox[0].length);
        const environmentName = name?.content.trim();
        return environmentName && /^[a-zA-Z@][a-zA-Z0-9@*.-]*$/.test(environmentName)
            ? { name: environmentName, definition: { kind: 'transparent' } }
            : undefined;
    }

    const command = /^\\(newtheorem|(?:re)?newenvironment)(\*)?/.exec(fullDefinition);
    if (!command) { return undefined; }

    let index = command[0].length;
    const name = readLatexGroup(fullDefinition, index);
    if (!name) { return undefined; }
    const environmentName = name.content.trim();
    if (!/^[a-zA-Z@][a-zA-Z0-9@*.-]*$/.test(environmentName)) { return undefined; }
    index = name.end;

    if (command[1] === 'newtheorem') {
        const sharedCounter = readLatexGroup(fullDefinition, index, { delimiter: 'bracket' });
        if (sharedCounter) { index = sharedCounter.end; }
        const displayName = readLatexGroup(fullDefinition, index);
        return displayName
            ? {
                name: environmentName,
                definition: { kind: 'theorem', displayName: displayName.content.trim(), numbered: !command[2] }
            }
            : undefined;
    }

    const argumentCount = readLatexGroup(fullDefinition, index, { delimiter: 'bracket' });
    if (argumentCount) {
        if (argumentCount.content.trim() !== '0') { return undefined; }
        index = argumentCount.end;
        const defaultArgument = readLatexGroup(fullDefinition, index, { delimiter: 'bracket' });
        if (defaultArgument) { index = defaultArgument.end; }
    }
    const opening = readLatexGroup(fullDefinition, index);
    const closing = opening && readLatexGroup(fullDefinition, opening.end);
    if (!opening || !closing) { return undefined; }

    if (!opening.content.trim() && !closing.content.trim()) {
        return { name: environmentName, definition: { kind: 'transparent' } };
    }
    const style = readStyleEnvironment(opening.content, closing.content);
    if (style) {
        return { name: environmentName, definition: { kind: 'style', declaration: style } };
    }

    const begin = readEnvironmentBoundary(opening.content, 'begin');
    const end = readEnvironmentBoundary(closing.content, 'end');
    const alias = begin && end?.target === begin.target
        ? { kind: 'alias' as const, target: begin.target, ...(begin.options ? { options: begin.options } : {}) }
        : readWrappedListEnvironmentAlias(opening.content, closing.content);
    return alias && environmentName !== alias.target ? { name: environmentName, definition: alias } : undefined;
}

interface MetadataCommandCall extends TextRange {
    name: string;
    content: string;
    optionalArg?: string;
    detailContent?: string;
}

const AUTHOR_METADATA_COMMANDS = [
    'IEEEauthorblockN',
    'IEEEauthorblockA',
    'address',
    'affiliation',
    'institute',
    'author',
    'email',
    'affil',
    'ead'
];
const AUTHOR_METADATA_COMMAND_PATTERN = [...AUTHOR_METADATA_COMMANDS]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
const EMAIL_PATTERN_SOURCE = '[A-Z0-9._%+-]+@[A-Z0-9.-]*[A-Z0-9]';

/**
 * Metadata command readers for built-in and user-provided extractors.
 *
 * Example:
 *   readMetadataCommand(source, 'editor')
 * reads \editor{Prof. Smith} and returns both the content and source range
 * so the command can be blanked out before body rendering.
 */
export function readMetadataCommand(text: string, commandName: string): { content: string; range: TextRange } | undefined {
    const result = findCommand(text, commandName);
    return result ? { content: result.content, range: { start: result.start, end: result.end } } : undefined;
}

function collectAuthorCommandCalls(text: string): MetadataCommandCall[] {
    const commandRegex = new RegExp(`\\\\(${AUTHOR_METADATA_COMMAND_PATTERN})\\b`, 'g');
    const calls: MetadataCommandCall[] = [];
    let match: RegExpExecArray | null;

    while ((match = commandRegex.exec(text)) !== null) {
        const name = match[1];
        const call = readLatexCommandAt(text, match.index, {
            name,
            optionalArgs: 1,
            requiredArgs: 1,
            allowStar: true,
            skipWhitespace: false
        });
        if (!call) { continue; }

        const detailGroup = name === 'author'
            ? readLatexGroup(text, call.end)
            : undefined;
        const end = detailGroup?.end ?? call.end;
        calls.push({
            name,
            content: call.requiredArgs[0].content.trim(),
            optionalArg: call.optionalArgs[0]?.content.trim(),
            detailContent: detailGroup?.content.trim(),
            start: call.start,
            end
        });
        commandRegex.lastIndex = end;
    }

    return calls;
}

function splitTrimmed(value: string, separator: RegExp): string[] {
    return value
        .split(separator)
        .map(part => part.trim())
        .filter(Boolean);
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function stripAuthorMarkers(value: string): string {
    return normalizeWhitespace(resolveLatexTextTransforms(value)
        .replace(/\\(?:inst|IEEEauthorrefmark|thanks|corref|tnoteref)\s*\{[^{}]*\}/g, '')
        .replace(/^\s*,\s*|\s*,\s*$/g, ''));
}

function extractInstIds(value: string): string[] {
    return Array.from(value.matchAll(/\\inst\s*\{([^{}]+)\}/g)).flatMap(match => splitTrimmed(match[1], /[,;]/));
}

function splitEmails(content: string): string[] {
    const plain = content
        .replace(/\\(?:texttt|email)\s*\{([^{}]*)\}/g, '$1')
        .replace(/^Email:\s*/i, '');
    return Array.from(new Set(plain.match(new RegExp(EMAIL_PATTERN_SOURCE, 'gi')) ?? []));
}

function stripAffiliationEmailText(content: string): string {
    return content
        .replace(new RegExp(`(?:^|\\s|\\\\\\\\)\\s*E-?mail\\s*(?:\\\\,\\s*)?\\$?[^\\\\\\n{}]*${EMAIL_PATTERN_SOURCE}[^\\\\\\n{}]*\\$?`, 'gim'), '')
        .replace(/^\s*Address\s*(?:\\\\|\n|:)?\s*/i, '');
}

function appendUnique(target: string[], values: readonly string[]): void {
    for (const value of values) {
        if (value && !target.includes(value)) {
            target.push(value);
        }
    }
}

function appendUniqueValue(target: string[], value: string | undefined): void {
    if (value) { appendUnique(target, [value]); }
}

function appendEmailsByPosition(authors: AuthorMetadata[], emails: readonly string[]): boolean {
    const targets = authors.filter(author => author.emails.length === 0);
    if (emails.length <= 1 || targets.length !== emails.length) { return false; }

    targets.forEach((author, index) => appendUniqueValue(author.emails, emails[index]));
    return true;
}

const AFFILIATION_FIELD_COMMANDS = ['institution', 'organization', 'department', 'city', 'state', 'country'];
const AFFILIATION_KEY_VALUE_REGEX = new RegExp(`\\b(?:${AFFILIATION_FIELD_COMMANDS.join('|')})\\s*=\\s*\\{([^{}]*)\\}`, 'g');

/**
 * Affiliation text normalization.
 *
 * ACM style:
 *   \affiliation{\institution{University A}\city{Town}\country{USA}}
 *
 * Elsevier/key-value style:
 *   \affiliation[inst1]{organization={University B}, city={City}, country={UK}}
 */
function formatAffiliationContent(content: string): string {
    content = content.replace(/(?:\\\\\s*)?\\(?:email|ead)\s*\{[^{}]*\}/g, '');
    content = stripAffiliationEmailText(content);
    const pieces: string[] = [];

    for (const field of AFFILIATION_FIELD_COMMANDS) {
        const result = findCommand(content, field);
        if (result?.content) {
            pieces.push(result.content);
        }
    }

    content.replace(AFFILIATION_KEY_VALUE_REGEX, (_match, value: string) => {
        pieces.push(value);
        return '';
    });

    return (pieces.length > 0 ? pieces : [content]).map(normalizeWhitespace).filter(Boolean).join(', ');
}

function addAffiliation(affiliations: AffiliationMetadata[], text: string, preferredId?: string): string | undefined {
    const cleanText = formatAffiliationContent(text);
    if (!cleanText) { return undefined; }

    if (preferredId) {
        const existingById = affiliations.find(affiliation => affiliation.id === preferredId);
        if (existingById) {
            if (!existingById.text) { existingById.text = cleanText; }
            return existingById.id;
        }
    }

    const existingByText = affiliations.find(affiliation => affiliation.text === cleanText);
    if (existingByText) { return existingByText.id; }

    const id = preferredId || String(affiliations.length + 1);
    affiliations.push({ id, text: cleanText });
    return id;
}

function addAuthor(authors: AuthorMetadata[], name: string, affiliationIds: string[] = [], emails: string[] = []): AuthorMetadata | undefined {
    const author = {
        name: stripAuthorMarkers(name),
        emails: Array.from(new Set(emails)),
        affiliationIds: Array.from(new Set(affiliationIds.filter(Boolean)))
    };
    if (!author.name) { return undefined; }
    authors.push(author);
    return author;
}

/**
 * \inst / \institute style title info.
 *
 * Example:
 *   \author{Alice\inst{1} \and Bob\inst{2}}
 *   \institute{University A \and University B}
 */
function parseInstituteContent(
    content: string,
    authors: AuthorMetadata[],
    affiliations: AffiliationMetadata[]
): void {
    const parts = splitTrimmed(content, /\\and\b/g);

    parts.forEach((part, index) => {
        const id = String(index + 1);
        const affiliationId = addAffiliation(affiliations, part, id);
        const emails = splitEmails(part);
        authors
            .filter((author, authorIndex) => author.affiliationIds.includes(id) || (parts.length === authors.length && authorIndex === index))
            .forEach(author => {
                appendUniqueValue(author.affiliationIds, affiliationId);
                appendUnique(author.emails, emails);
            });
    });

    if (authors.length > 0 && !authors.some(author => author.affiliationIds.length > 0) && affiliations.length === 1) {
        authors.forEach(author => appendUniqueValue(author.affiliationIds, affiliations[0].id));
    }
}

/**
 * IEEE style title info.
 *
 * Example:
 *   \IEEEauthorblockN{Alice Smith, Bob Jones}
 *   \IEEEauthorblockA{University A\\Email: alice@a.edu}
 */
function parseIeeeAuthors(calls: MetadataCommandCall[]): AuthorExtraction {
    const authors: AuthorMetadata[] = [];
    const affiliations: AffiliationMetadata[] = [];
    let pendingAuthorIndices: number[] = [];

    for (const call of calls) {
        if (call.name === 'IEEEauthorblockN') {
            pendingAuthorIndices = [];
            splitTrimmed(call.content, /\s*,\s*|\\and\b/g)
                .map(part => stripAuthorMarkers(part))
                .filter(Boolean)
                .forEach(name => {
                    pendingAuthorIndices.push(authors.length);
                    addAuthor(authors, name);
                });
        } else if (call.name === 'IEEEauthorblockA') {
            const id = addAffiliation(affiliations, call.content);
            const emails = splitEmails(call.content);
            pendingAuthorIndices.forEach(index => {
                const author = authors[index];
                if (author) {
                    appendUniqueValue(author.affiliationIds, id);
                    appendUnique(author.emails, emails);
                }
            });
        }
    }

    return { authors, affiliations };
}

/**
 * Main author parser for non-IEEE forms.
 *
 * Plain free-form block, preserved as one display string:
 *   \author{Alice\\University A\\\texttt{alice@a.edu}\and Bob\\University B}
 *
 * Repeated/authblk forms:
 *   \author{Alice} \email{alice@a.edu} \address{University A}
 *   \author[1]{Alice} \author[1]{Bob} \affil[1]{University A}
 *   \author[1]{Alice} \author[2]{Bob} \email{alice@a.edu, bob@b.edu}
 *
 * Elsevier-like forms:
 *   \author[inst1]{Bob} \ead{bob@b.edu}
 *   \affiliation[inst1]{organization={University B}}
 */
function parseAuthorCommands(calls: MetadataCommandCall[]): AuthorExtraction {
    if (calls.some(call => call.name === 'IEEEauthorblockN' || call.name === 'IEEEauthorblockA')) {
        return parseIeeeAuthors(calls);
    }

    const authors: AuthorMetadata[] = [];
    const affiliations: AffiliationMetadata[] = [];
    let currentAuthor: AuthorMetadata | undefined;
    const plainAuthor = calls.length === 1 && calls[0].name === 'author'
        && !calls[0].optionalArg
        && !calls[0].detailContent
        && !/\\inst\s*\{/.test(calls[0].content);

    if (plainAuthor) {
        return {
            authors: [{
                name: calls[0].content,
                emails: [],
                affiliationIds: []
            }],
            affiliations
        };
    }

    for (const call of calls) {
        switch (call.name) {
            case 'author': {
                // Handles repeated \author, authblk \author[1], and \author{Alice\inst{1}}.
                const optionalIds = call.optionalArg ? splitTrimmed(call.optionalArg, /[,;]/) : [];
                const detailAffiliationId = call.detailContent ? addAffiliation(affiliations, call.detailContent) : undefined;
                const detailEmails = call.detailContent ? splitEmails(call.detailContent) : [];
                for (const part of splitTrimmed(call.content, /\\(?:and|And)\b/g)) {
                    const instIds = extractInstIds(part);
                    const affiliationIds = [
                        ...(instIds.length > 0 ? instIds : optionalIds),
                        ...(detailAffiliationId ? [detailAffiliationId] : [])
                    ];
                    const author = addAuthor(authors, part, affiliationIds, detailEmails);
                    if (author) { currentAuthor = author; }
                }
                break;
            }
            case 'email':
            case 'ead': {
                // A single email attaches to the latest author; a list matching all
                // authors without emails is distributed by author order.
                const emails = splitEmails(call.content);
                if (!appendEmailsByPosition(authors, emails) && currentAuthor) {
                    appendUnique(currentAuthor.emails, emails);
                }
                break;
            }
            case 'affil':
            case 'address':
            case 'affiliation': {
                // Handles journal \address, authblk \affil, ACM \affiliation, and Elsevier \affiliation[id].
                const optionalId = call.optionalArg?.trim();
                if (!optionalId && call.content.includes('@') && currentAuthor) {
                    appendUnique(currentAuthor.emails, splitEmails(call.content));
                    break;
                }
                const id = addAffiliation(affiliations, call.content, optionalId || undefined);
                if (!optionalId && currentAuthor) {
                    appendUniqueValue(currentAuthor.affiliationIds, id);
                }
                break;
            }
            case 'institute':
                parseInstituteContent(call.content, authors, affiliations);
                break;
        }
    }

    return { authors, affiliations };
}

function mergeExtractionResult(target: PreambleMetadata, result: MetadataExtractionResult): void {
    if (result.title !== undefined) { target.title = result.title; }
    if (result.date !== undefined) { target.date = result.date; }
    if (result.keywords && result.keywords.length > 0) { target.keywords = result.keywords; }
    if (result.authors && result.authors.length > 0) { target.authors = result.authors; }
    if (result.affiliations && result.affiliations.length > 0) { target.affiliations = result.affiliations; }
    if (result.custom) { Object.assign(target.custom, result.custom); }
}

/**
 * Built-in title metadata extractor.
 *
 * Scalar fields:
 *   \title{...}, \date{...}, \keywords{...}
 *
 * Author fields are routed through parseAuthorCommands() so the output always
 * uses the same AuthorMetadata/AffiliationMetadata shape regardless of template.
 */
export const BUILTIN_METADATA_EXTRACTOR: MetadataExtractor = (text): MetadataExtractionResult => {
    const ranges: TextRange[] = [];
    const title = readMetadataCommand(text, 'title');
    const date = readMetadataCommand(text, 'date');
    const keywords = readMetadataCommand(text, 'keywords') ?? readMetadataCommand(text, 'keyword');
    const titleMark = readMetadataCommand(text, 'TitleMark');
    const authorMark = readMetadataCommand(text, 'AuthorMark');

    if (title) { ranges.push(title.range); }
    if (date) { ranges.push(date.range); }
    if (keywords) { ranges.push(keywords.range); }
    if (titleMark) { ranges.push(titleMark.range); }
    if (authorMark) { ranges.push(authorMark.range); }

    const authorCalls = collectAuthorCommandCalls(text);
    authorCalls.forEach(call => ranges.push({ start: call.start, end: call.end }));
    const { authors, affiliations } = parseAuthorCommands(authorCalls);

    return {
        title: title?.content,
        date: date?.content,
        authors,
        affiliations,
        keywords: keywords ? [keywords.content] : [],
        custom: {
            ...(titleMark ? { titleMark: titleMark.content } : {}),
            ...(authorMark ? { authorMark: authorMark.content } : {})
        },
        ranges
    };
};

/**
 * Extracts preamble metadata, macro definitions, and TikZ globals.
 *
 * The returned cleanedText preserves line structure for source mapping while
 * blanking definitions that should not render as document body content.
 */
export function extractMetadata(
    text: string,
    metadataExtractors: readonly MetadataExtractor[],
    definitionSources: readonly string[] = []
): MetadataResult {
    let cleanedText = maskLatexFalseBranches(stripLatexComments(text, { mode: 'mask' }));

    const todayStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    cleanedText = cleanedText.replace(/\\today\b/g, todayStr);

    const metadata: PreambleMetadata = {
        authors: [],
        affiliations: [],
        keywords: [],
        custom: {}
    };
    const metadataRanges: TextRange[] = [];

    for (const extractor of metadataExtractors) {
        const result = extractor(cleanedText);
        mergeExtractionResult(metadata, result);
        metadataRanges.push(...(result.ranges ?? []));
    }
    cleanedText = blankOutRanges(cleanedText, metadataRanges);

    const tikzGlobalParts: string[] = [];
    const tikzMacroMap = new Map<string, string>();
    const macros: Record<string, LatexMacroDefinition> = {};
    const activeMacros: Record<string, LatexMacroDefinition> = {};
    const macroAliases: LatexMacroAlias[] = [];
    const colors: Record<string, string> = {};
    const environments: Record<string, PreambleEnvironmentDefinition> = {};
    const usedMacros = new Set(cleanedText.match(/\\[a-zA-Z@]+/g) ?? []);
    const usedEnvironments = new Set(
        Array.from(cleanedText.matchAll(/\\(?:begin|end)\s*\{([^{}]+)\}/g), match => match[1])
    );

    const definitionRecords = collectDefinitions(cleanedText);
    const records = [
        ...definitionSources.flatMap(source =>
            collectDefinitions(maskLatexFalseBranches(stripLatexComments(source, { mode: 'mask' })))
                .map(record => ({ record, imported: true }))
        ),
        ...definitionRecords.map(record => ({ record, imported: false }))
    ];
    const importedHeaders = new Map(records.flatMap(({ record, imported }) => {
        const header = imported && record.command !== 'let' ? readMacroDefinitionHeader(record.fullDef) : undefined;
        return header ? [[header.name, header] as const] : [];
    }));
    const relevantMacros = new Set(usedMacros);
    for (const name of relevantMacros) {
        for (const match of importedHeaders.get(name)?.body.content.matchAll(/\\[a-zA-Z@]+/g) ?? []) {
            relevantMacros.add(match[0]);
        }
    }
    const aliasTargets = new Set(records.flatMap(({ record }) => {
        const alias = record.command === 'let' ? readMacroAlias(record.fullDef) : undefined;
        return alias ? [alias.target] : [];
    }));
    for (const { record, imported } of records) {
        const { command, fullDef } = record;

        if (command === 'let') {
            const alias = readMacroAlias(fullDef);
            if (alias) {
                macroAliases.push({ ...alias, targetDefinition: activeMacros[alias.target] });
                if (activeMacros[alias.target]) {
                    activeMacros[alias.name] = activeMacros[alias.target];
                }
            }
            continue;
        }

        if (command === 'definecolor') {
            const colorDefinition = extractColorDefinition(fullDef);
            if (colorDefinition) {
                colors[colorDefinition.name] = colorDefinition.color;
            }
        }

        const environment = extractEnvironmentDefinition(fullDef);
        if (environment) {
            if (!imported || usedEnvironments.has(environment.name)) {
                environments[environment.name] = environment.definition;
            }
            continue;
        }

        if (TIKZ_GLOBAL_COMMANDS.includes(command)) {
            if (!tikzGlobalParts.includes(fullDef)) {
                tikzGlobalParts.push(fullDef);
            }
            continue;
        }

        const header = readMacroDefinitionHeader(fullDef);
        if (!header || (imported && !relevantMacros.has(header.name) && !aliasTargets.has(header.name))) {
            continue;
        }

        const finalDef = transpileToDef(header, fullDef);
        const katexMacro = extractKatexMacro(header);
        if (katexMacro && (header.command !== 'providecommand' || activeMacros[katexMacro.name] === undefined)) {
            activeMacros[katexMacro.name] = katexMacro.definition;
        }
        if (imported && !isDeclarativeMacroBody(header.body.content)) {
            continue;
        }
        const tikzName = header.command === 'DeclareMathOperator' ? null : header.name;
        if (tikzName && !tikzMacroMap.has(tikzName)) {
            tikzMacroMap.set(tikzName, finalDef);
        }

        if (katexMacro && (header.command !== 'providecommand' || macros[katexMacro.name] === undefined)) {
            macros[katexMacro.name] = katexMacro.definition;
        }
    }

    const tikzGlobal = tikzGlobalParts.join('\n');
    cleanedText = blankOutRanges(cleanedText, definitionRecords);
    const aliasReferences = new Set(usedMacros);
    for (const definition of Object.values(activeMacros)) {
        for (const match of definition.body.matchAll(/\\[a-zA-Z@]+/g)) {
            aliasReferences.add(match[0]);
        }
    }
    for (let i = macroAliases.length - 1; i >= 0; i--) {
        if (aliasReferences.has(macroAliases[i].name)) {
            aliasReferences.add(macroAliases[i].target);
        }
    }
    const data: PreambleData = {
        macros,
        macroAliases: macroAliases.filter(alias => aliasReferences.has(alias.name)),
        colors,
        environments,
        tikzGlobal,
        tikzMacroMap,
        ...metadata
    };
    return { data, cleanedText };
}
