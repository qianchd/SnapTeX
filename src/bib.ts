import { cleanLatexCommands, escapeHtml, escapeHtmlAttribute, sanitizeHttpUrlForAttribute } from './utils';
import type { BibEntry, RenderContext } from './types';

/**
 * Small BibTeX parser used for preview citations and bibliography rendering.
 *
 * It extracts balanced entry blocks before field parsing so nested braces in
 * titles, author names, and LaTeX accents do not break common bibliography
 * previews. It is intentionally permissive rather than a full BibTeX engine.
 */
export class BibTexParser {
    public static parse(content: string): Map<string, BibEntry> {
        const entries = new Map<string, BibEntry>();

        const entryRegex = /@([a-zA-Z]+)\s*\{\s*([^,\s\}]+)\s*,/g;
        let match;

        while ((match = entryRegex.exec(content)) !== null) {
            const type = match[1].toLowerCase();
            const key = match[2].trim();
            const startIndex = match.index;

            let block = this.extractBalancedBlock(content, startIndex);
            if (!block) { continue; }

            block = block.replace(/\r\n/g, '\n')
                         .replace(/^\s*\/\/\s+.*/gm, '')
                         .replace(/(?<!\\)%.*$/gm, '');
            const fields = this.parseFieldsRobust(block);
            if (Object.keys(fields).length > 0) {
                entries.set(key, { key, type, fields });
            }
        }
        return entries;
    }

    private static extractBalancedBlock(text: string, startIndex: number): string | null {
        let braceCount = 0;
        let foundStart = false;
        const maxLen = Math.min(text.length, startIndex + 50000);

        for (let i = startIndex; i < maxLen; i++) {
            const char = text[i];
            if (char === '\\') {
                i++;
                continue;
            }
            if (char === '{') {
                braceCount++;
                foundStart = true;
            } else if (char === '}') {
                braceCount--;
            }

            if (foundStart && braceCount === 0) {
                return text.substring(startIndex, i + 1);
            }
        }
        return null;
    }

    private static parseFieldsRobust(block: string): Record<string, string> {
        const fields: Record<string, string> = {};

        const bodyStart = block.indexOf(',');
        if (bodyStart === -1) {return fields;}

        const content = block.substring(bodyStart + 1, block.lastIndexOf('}'));

        let cursor = 0;
        const len = content.length;

        while (cursor < len) {
            while (cursor < len && /[\s,]/.test(content[cursor])) {
                cursor++;
            }
            if (cursor >= len) {break;}

            const nameStart = cursor;
            while (cursor < len && /[a-zA-Z0-9_\-./]/.test(content[cursor])) {
                cursor++;
            }
            const fieldName = content.substring(nameStart, cursor).toLowerCase().trim();

            while (cursor < len && /[\s=]/.test(content[cursor])) {
                cursor++;
            }

            let value = "";
            if (cursor < len) {
                const startChar = content[cursor];

                if (startChar === '{') {
                    let braceDepth = 1;
                    const valStart = cursor + 1;
                    cursor++;

                    while (cursor < len && braceDepth > 0) {
                        const c = content[cursor];
                        if (c === '\\') {
                            cursor += 2; continue;
                        }
                        if (c === '{') {braceDepth++;}
                        else if (c === '}') {braceDepth--;}

                        if (braceDepth > 0) {cursor++;}
                    }
                    value = content.substring(valStart, cursor);
                    cursor++;

                } else if (startChar === '"') {
                    const valStart = cursor + 1;
                    cursor++;
                    while (cursor < len) {
                        if (content[cursor] === '\\') {
                            cursor += 2; continue;
                        }
                        if (content[cursor] === '"') {break;}
                        cursor++;
                    }
                    value = content.substring(valStart, cursor);
                    cursor++;

                } else {
                    const valStart = cursor;
                    while (cursor < len && content[cursor] !== ',') {
                        cursor++;
                    }
                    value = content.substring(valStart, cursor).trim();
                }
            }

            if (fieldName && value) {
                fields[fieldName] = value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
            }
        }

        return fields;
    }

    public static formatEntry(entry: BibEntry, renderer: Pick<RenderContext, 'protectHtml'>): string {
        const f = entry.fields;

        let author = f.author ? cleanLatexCommands(f.author, renderer) : 'Unknown';
        author = author.replace(/\s+and\s+/g, ', ');

        const title = f.title ? cleanLatexCommands(f.title, renderer) : 'No Title';
        const year = escapeHtml(f.year || f.date || 'n.d.');

        const journal = f.journal || f.fjournal || f.booktitle || f.publisher || '';

        let html = `${author} (${year}). <em>${title}</em>.`;

        if (journal) {
            html += ` ${cleanLatexCommands(journal, renderer)}`;
            if (f.volume) {html += `, <strong>${escapeHtml(f.volume)}</strong>`;}
            if (f.number) {html += `(${escapeHtml(f.number)})`;}
            html += `.`;
        }

        if (f.pages) {
            html += ` pp. ${escapeHtml(f.pages.replace('--', '-'))}.`;
        }

        if (f.doi) {
            const doi = f.doi.trim();
            const href = escapeHtmlAttribute(`https://doi.org/${encodeURI(doi)}`);
            html += ` <a href="${href}" style="color:#007acc;">doi:${escapeHtml(doi)}</a>`;
        } else if (f.url) {
            const href = sanitizeHttpUrlForAttribute(f.url);
            if (href) {
                html += ` <a href="${href}" style="color:#007acc;">[Link]</a>`;
            }
        }

        return html;
    }

    public static getShortAuthor(entry: BibEntry): string {
        if (!entry.fields.author) { return 'Unknown'; }

        let cleanName = entry.fields.author.replace(/[{}]/g, '');

        cleanName = cleanName.replace(/\\['"`^~]\{?([a-zA-Z])\}?/g, '$1');
        cleanName = cleanName.replace(/\\[a-zA-Z]+\s*/g, '');

        const authors = cleanName.split(/\s+and\s+/i);

        const getSurname = (n: string) => {
            const trimmed = n.trim();
            if (trimmed.includes(',')) {
                return trimmed.split(',')[0].trim();
            }
            const parts = trimmed.split(/\s+/);
            return parts[parts.length - 1];
        };

        if (authors.length > 2) {
            return `${escapeHtml(getSurname(authors[0]))} <em>et al.</em>`;
        }
        if (authors.length === 2) {
            return `${escapeHtml(getSurname(authors[0]))} &amp; ${escapeHtml(getSurname(authors[1]))}`;
        }
        return escapeHtml(getSurname(authors[0]));
    }
}
