import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DocumentParseResult, LatexDocument } from '../document';
import type { IFileProvider } from '../file-provider';
import { SmartRenderer } from '../renderer';
import { BlockTextProvider, LatexCounterScanner } from '../scanner';
import { AffiliationMetadata, AuthorMetadata, BlockTextSpan } from '../types';
import { normalizeUri, stableHash } from '../utils';

export class MemoryFileProvider implements IFileProvider<vscode.Uri> {
    constructor(private readonly files: Map<string, string> = new Map()) {}

    async read(uri: vscode.Uri): Promise<string> {
        const content = this.files.get(normalizeUri(uri));
        if (content === undefined) {
            throw new Error(`Missing test file: ${uri.toString()}`);
        }
        return content;
    }

    async exists(uri: vscode.Uri): Promise<boolean> {
        return this.files.has(normalizeUri(uri));
    }

    async stat(uri: vscode.Uri): Promise<{ mtime: number }> {
        return { mtime: this.files.has(normalizeUri(uri)) ? 1 : 0 };
    }

    resolve(base: vscode.Uri, relative: string): vscode.Uri {
        return vscode.Uri.joinPath(base, relative);
    }

    dir(uri: vscode.Uri): vscode.Uri {
        return vscode.Uri.joinPath(uri, '..');
    }
}

export function createDocument(
    blockTexts: string[],
    options: {
        macros?: Record<string, string>;
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
        line += lineCount;
    }

    doc.applyResult({
        bodyText,
        blockSpans,
        blockHashes: blockTexts.map(text => stableHash(text)),
        filePool: [],
        sourceFileIndices: new Uint16Array(0),
        sourceLines: new Int32Array(0),
        metadata: {
            macros: options.macros ?? {},
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
    return text.slice(span.start, span.end);
}

export function resultBlockTexts(result: DocumentParseResult): string[] {
    return result.blockSpans.map(span => spanText(result.bodyText, span));
}

export function createBlockTextProvider(blocks: string[], reads?: number[]): BlockTextProvider {
    return {
        getBlockCount: () => blocks.length,
        getBlockText: (index: number) => {
            reads?.push(index);
            return blocks[index];
        },
        getBlockHash: (index: number) => blocks[index] === undefined ? undefined : stableHash(blocks[index])
    };
}

export function scanBlocks(blocks: string[], scanner = new LatexCounterScanner()) {
    return scanner.scan(createBlockTextProvider(blocks));
}

