import { AffiliationMetadata, AuthorMetadata, MetadataExtractionResult, MetadataExtractor, MetadataResult, PreambleData, PreambleMetadata, TextRange } from './types';
import { findCommand, readLatexCommandAt, readLatexGroup, resolveLatexTextTransforms, skipLatexWhitespace, stripLatexComments } from './utils';

type MacroDefinitionCommand = 'newcommand' | 'renewcommand' | 'providenewcommand' | 'def' | 'gdef' | 'DeclareMathOperator';
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
    hasDefaultArgument: boolean;
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
    const commandMatch = /^\\((?:provide|re)?newcommand|g?def|DeclareMathOperator)(\*)?/.exec(fullDef);
    if (!commandMatch) { return undefined; }

    const command = commandMatch[1] as MacroDefinitionCommand;
    const star = commandMatch[2] === '*';
    const macroName = readMacroName(fullDef, commandMatch[0].length);
    if (!macroName) { return undefined; }

    let index = macroName.end;
    let argCount = 0;
    let hasDefaultArgument = false;

    if (command === 'newcommand' || command === 'renewcommand' || command === 'providenewcommand') {
        const argCountGroup = readLatexGroup(fullDef, index, { delimiter: 'bracket' });
        if (argCountGroup && /^\d+$/.test(argCountGroup.content.trim())) {
            argCount = parseInt(argCountGroup.content.trim(), 10);
            index = argCountGroup.end;

            const defaultArgGroup = readLatexGroup(fullDef, index, { delimiter: 'bracket' });
            if (defaultArgGroup) {
                hasDefaultArgument = true;
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
        argCount,
        hasDefaultArgument,
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
    if (!header.command.endsWith('newcommand') || header.hasDefaultArgument) {return fullDef;}

    const args = Array.from({ length: header.argCount }, (_unused, index) => `#${index + 1}`).join('');
    return `\\def${header.name}${args}${fullDef.substring(header.body.start)}`;
}

interface DefinitionRecord extends TextRange {
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

function blankOutRanges(text: string, ranges: TextRange[]): string {
    if (ranges.length === 0) { return text; }

    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    let result = "";
    let cursor = 0;

    for (const range of sorted) {
        const start = Math.max(cursor, range.start);
        const end = Math.max(start, range.end);
        result += text.substring(cursor, start);
        result += text.substring(start, end).replace(/[^\r\n]/g, '');
        cursor = end;
    }

    result += text.substring(cursor);
    return result;
}

function collectDefinitions(text: string): DefinitionRecord[] {
    const records: DefinitionRecord[] = [];
    const defRegex = /\\(provide|re)?(newcommand|def|gdef|DeclareMathOperator|usetikzlibrary|tikzset|definecolor)(\*?)/g;

    let defMatch;
    while ((defMatch = defRegex.exec(text)) !== null) {
        const start = defMatch.index;
        const end = findDefinitionEnd(text, start + defMatch[0].length);
        if (end === -1) { continue; }

        records.push({ start, end, fullDef: text.substring(start, end) });
        defRegex.lastIndex = end;
    }

    return records;
}

function extractKatexMacro(header: MacroDefinitionHeader): { name: string; definition: string } | undefined {
    if (header.command === 'providenewcommand') { return undefined; }

    const rawDefinition = header.body.content.trim();
    const definition = header.command === 'DeclareMathOperator'
        ? (header.star ? `\\operatorname*{${rawDefinition}}` : `\\operatorname{${rawDefinition}}`)
        : rawDefinition;

    return { name: header.name, definition };
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
    'affiliation',
    'institute',
    'author',
    'email',
    'affil',
    'ead'
];
const AUTHOR_METADATA_COMMAND_PATTERN = [...AUTHOR_METADATA_COMMANDS]
    .sort((a, b) => b.length - a.length)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
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
 *   \author{Alice} \email{alice@a.edu} \affiliation{University A}
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
            case 'affiliation': {
                // Handles authblk \affil, ACM \affiliation, and Elsevier \affiliation[id].
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
export const BUILTIN_METADATA_EXTRACTOR: MetadataExtractor = {
    name: 'builtin',
    extract: (text: string): MetadataExtractionResult => {
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
    }
};

/**
 * Extracts preamble metadata, macro definitions, and TikZ globals.
 *
 * The returned cleanedText preserves line structure for source mapping while
 * blanking definitions that should not render as document body content.
 */
export function extractMetadata(text: string, metadataExtractors: readonly MetadataExtractor[]): MetadataResult {
    let cleanedText = stripLatexComments(text, { preserveLines: true });

    cleanedText = cleanedText.replace(/\$\$\s*\$\$/g, ' ');

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
        const result = extractor.extract(cleanedText);
        mergeExtractionResult(metadata, result);
        metadataRanges.push(...(result.ranges ?? []));
    }
    cleanedText = blankOutRanges(cleanedText, metadataRanges);

    const tikzGlobalParts: string[] = [];
    const tikzMacroMap = new Map<string, string>();
    const macros: Record<string, string> = {};

    const definitionRecords = collectDefinitions(cleanedText);
    for (const record of definitionRecords) {
        const { fullDef } = record;

        if (/\\(usetikzlibrary|tikzset|definecolor)/.test(fullDef)) {
            if (!tikzGlobalParts.includes(fullDef)) {
                tikzGlobalParts.push(fullDef);
            }
            continue;
        }

        const header = readMacroDefinitionHeader(fullDef);
        if (!header) { continue; }

        const finalDef = transpileToDef(header, fullDef);
        const tikzName = header.command === 'DeclareMathOperator' ? null : header.name;
        if (tikzName && !tikzMacroMap.has(tikzName)) {
            tikzMacroMap.set(tikzName, finalDef);
        }

        const katexMacro = extractKatexMacro(header);
        if (katexMacro) {
            macros[katexMacro.name] = katexMacro.definition;
        }
    }

    const tikzGlobal = tikzGlobalParts.join('\n');
    cleanedText = blankOutRanges(cleanedText, definitionRecords);
    const data: PreambleData = {
        macros,
        tikzGlobal,
        tikzMacroMap,
        ...metadata
    };
    return { data, cleanedText };
}
