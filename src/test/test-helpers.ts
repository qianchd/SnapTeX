import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { BrowserFileProvider, BrowserUri } from '../../apps/standalone/src/browser-file-provider';
import { DocumentParseResult, LatexDocument } from '../document';
import { SmartRenderer } from '../renderer';
import { AffiliationMetadata, AuthorMetadata, BlockTextSpan, PreambleData } from '../types';
import { getBlockSpanText, normalizeUri, stableHash } from '../utils';

export class MemoryFileProvider extends BrowserFileProvider {
    constructor(private readonly contents: Map<string, string> = new Map()) { super(); }

    override async read(uri: BrowserUri): Promise<string> {
        const content = this.contents.get(normalizeUri(uri));
        if (content === undefined) {
            throw new Error(`Missing test file: ${uri.toString()}`);
        }
        return content;
    }

    override async exists(uri: BrowserUri): Promise<boolean> {
        return this.contents.has(normalizeUri(uri));
    }

    override async stat(uri: BrowserUri): Promise<{ mtime: number }> {
        return { mtime: this.contents.has(normalizeUri(uri)) ? 1 : 0 };
    }
}

export function createDocument(
    blockTexts: string[],
    options: {
        macros?: PreambleData['macros'];
        colors?: Record<string, string>;
        environments?: PreambleData['environments'];
        tikzGlobal?: string;
        title?: string;
        date?: string;
        authors?: AuthorMetadata[];
        affiliations?: AffiliationMetadata[];
        keywords?: string[];
        custom?: Record<string, string>;
    } = {}
): LatexDocument {
    const doc = new LatexDocument(new MemoryFileProvider());
    let bodyText = "";
    let offset = 0;
    let line = 0;
    const blockSpans: BlockTextSpan[] = [];

    for (let index = 0; index < blockTexts.length; index++) {
        if (index > 0) {
            bodyText += '\n\n';
            offset += 2;
            line += 2;
        }

        const text = blockTexts[index];
        const start = offset;
        const end = start + text.length;
        const lineCount = text.split(/\r?\n/).length;
        bodyText += text;
        blockSpans.push({ start, end, line, lineCount });
        offset = end;
        line += lineCount - 1;
    }

    doc.applyResult({
        bodyText,
        blockSpans,
        blockHashes: blockTexts.map(text => stableHash(text)),
        astBlockArtifacts: [],
        filePool: [],
        sourceMapSegments: [],
        metadata: {
            macros: options.macros ?? {},
            macroAliases: [],
            colors: options.colors ?? {},
            environments: options.environments ?? {},
            tikzGlobal: options.tikzGlobal ?? '',
            tikzMacroMap: new Map(),
            title: options.title,
            date: options.date,
            authors: options.authors ?? [],
            affiliations: options.affiliations ?? [],
            keywords: options.keywords ?? [],
            custom: options.custom ?? {}
        },
        bibEntries: new Map(),
        diagnostics: [],
        contentStartLineOffset: 0
    });
    return doc;
}

export function renderBlocks(blockTexts: string[]): string {
    const renderer = new SmartRenderer();
    const payload = renderer.render(createDocument(blockTexts));
    assert.equal(payload.type, 'full');
    assert.ok(payload.htmls);
    return payload.htmls.join('');
}

export function readFixture(name: string): string {
    return fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', name), 'utf8');
}

export function spanText(text: string, span: BlockTextSpan): string {
    return getBlockSpanText(text, span);
}

export function resultBlockTexts(result: DocumentParseResult): string[] {
    return result.blockSpans.map(span => spanText(result.bodyText, span));
}

export function installTestGlobals(values: Record<string, unknown>): () => void {
    const previous = new Map(Object.keys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    for (const [name, value] of Object.entries(values)) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    return () => {
        for (const [name, descriptor] of previous) {
            if (descriptor) {Object.defineProperty(globalThis, name, descriptor);}
            else {Reflect.deleteProperty(globalThis, name);}
        }
    };
}
