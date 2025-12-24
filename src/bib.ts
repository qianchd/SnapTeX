import { cleanLatexCommands } from './utils';

export interface BibEntry {
    key: string;
    type: string;
    fields: Record<string, string>;
}

export class BibTexParser {
    public static parse(content: string): Map<string, BibEntry> {
        const entries = new Map<string, BibEntry>();

        // --- Deep Cleaning ---
        // Normalize line endings
        let clean = content.replace(/\r\n/g, '\n');
        // Remove C++ style comments
        clean = clean.replace(/^\s*\/\/\s+.*/gm, '');
        // Remove LaTeX style comments (ensure not escaped)
        clean = clean.replace(/(?<!\\)%.*$/gm, '');
        // Normalize Entry Start
        clean = clean.replace(/@([a-zA-Z]+)\s*\{\s*/g, '@$1{');

        // Regex to find the start of an entry: @article{key,
        const entryRegex = /@([a-zA-Z]+)\{([^,\s\}]+)\s*,/g;
        let match;

        while ((match = entryRegex.exec(clean)) !== null) {
            const type = match[1].toLowerCase();
            const key = match[2].trim();
            const startIndex = match.index;

            // Extract the full balanced block { ... }
            const block = this.extractBalancedBlock(clean, startIndex);
            if (block) {
                // Parse fields using the robust parser
                const fields = this.parseFieldsRobust(block);
                if (Object.keys(fields).length > 0) {
                    entries.set(key, { key, type, fields });
                }
            }
        }

        console.log(`[SnapTeX] Parsed ${entries.size} entries.`);
        return entries;
    }

    /**
     * Helper: Extract a block balanced with braces { ... } starting at startIndex
     */
    private static extractBalancedBlock(text: string, startIndex: number): string | null {
        let braceCount = 0;
        let foundStart = false;
        // Limit search to prevent freezing on huge files
        const maxLen = Math.min(text.length, startIndex + 50000);

        for (let i = startIndex; i < maxLen; i++) {
            const char = text[i];
            if (char === '\\') {
                i++; // Skip escaped char
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

    /**
     * [FIXED] Robust Field Parser
     * Replaces regex with a state machine to handle nested braces { { } } and quotes correctly.
     */
    private static parseFieldsRobust(block: string): Record<string, string> {
        const fields: Record<string, string> = {};

        // Skip the header part "@type{key,"
        const bodyStart = block.indexOf(',');
        if (bodyStart === -1) {return fields;}

        // Content inside the main entry braces
        const content = block.substring(bodyStart + 1, block.lastIndexOf('}'));

        let cursor = 0;
        const len = content.length;

        while (cursor < len) {
            // 1. Consume whitespace / commas
            while (cursor < len && /[\s,]/.test(content[cursor])) {
                cursor++;
            }
            if (cursor >= len) {break;}

            // 2. Read Field Name (e.g., "author")
            const nameStart = cursor;
            while (cursor < len && /[a-zA-Z0-9_\-./]/.test(content[cursor])) {
                cursor++;
            }
            const fieldName = content.substring(nameStart, cursor).toLowerCase().trim();

            // 3. Consume whitespace and '='
            while (cursor < len && /[\s=]/.test(content[cursor])) {
                cursor++;
            }

            // 4. Read Field Value
            let value = "";
            if (cursor < len) {
                const startChar = content[cursor];

                if (startChar === '{') {
                    // Case A: Braced Value { ... }
                    let braceDepth = 0;
                    const valStart = cursor + 1; // Skip outer {
                    cursor++; // Move into first brace
                    braceDepth = 1;

                    while (cursor < len && braceDepth > 0) {
                        const c = content[cursor];
                        if (c === '\\') {
                            cursor += 2; continue;
                        }
                        if (c === '{') {braceDepth++;}
                        else if (c === '}') {braceDepth--;}

                        if (braceDepth > 0) {cursor++;}
                    }
                    value = content.substring(valStart, cursor); // Content inside braces
                    cursor++; // Skip closing }

                } else if (startChar === '"') {
                    // Case B: Quoted Value " ... "
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
                    cursor++; // Skip closing "

                } else {
                    // Case C: Raw Value (Numbers or Strings without braces)
                    const valStart = cursor;
                    while (cursor < len && content[cursor] !== ',') {
                        cursor++;
                    }
                    value = content.substring(valStart, cursor).trim();
                }
            }

            if (fieldName && value) {
                // Normalize whitespace in value
                fields[fieldName] = value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
            }
        }

        return fields;
    }

    public static formatEntry(entry: BibEntry, renderer: any): string {
        const f = entry.fields;

        let author = f.author ? cleanLatexCommands(f.author, renderer) : 'Unknown';
        author = author.replace(/\s+and\s+/g, ', ');

        const title = f.title ? cleanLatexCommands(f.title, renderer) : 'No Title';
        const year = f.year || f.date || 'n.d.';

        const journal = f.journal || f.fjournal || f.booktitle || f.publisher || '';

        let html = `${author} (${year}). <em>${title}</em>.`;

        if (journal) {
            html += ` ${cleanLatexCommands(journal, renderer)}`;
            if (f.volume) {html += `, <strong>${f.volume}</strong>`;}
            if (f.number) {html += `(${f.number})`;}
            html += `.`;
        }

        if (f.pages) {
            html += ` pp. ${f.pages.replace('--', '-')}.`;
        }

        if (f.doi) {
            html += ` <a href="https://doi.org/${f.doi}" style="color:#007acc;">doi:${f.doi}</a>`;
        } else if (f.url) {
            html += ` <a href="${f.url}" style="color:#007acc;">[Link]</a>`;
        }

        return html;
    }

public static getShortAuthor(entry: BibEntry): string {
        if (!entry.fields.author) { return 'Unknown'; }

        // 1. Clean braces completely for logic processing
        // {\"o} -> "o (decodeLatexAccents handles the visual part, but here we just want raw logic)
        let cleanName = entry.fields.author.replace(/[{}]/g, '');

        // 2. Remove LaTeX commands (simplified)
        cleanName = cleanName.replace(/\\['"`^~]\{?([a-zA-Z])\}?/g, '$1'); // \'{a} -> a
        cleanName = cleanName.replace(/\\[a-zA-Z]+\s*/g, ''); // Remove other commands

        // 3. Split authors
        // BibTeX standard: "Author One and Author Two"
        const authors = cleanName.split(/\s+and\s+/i);

        const getSurname = (n: string) => {
            const trimmed = n.trim();
            // Format: "Smith, John" -> "Smith"
            if (trimmed.includes(',')) {
                return trimmed.split(',')[0].trim();
            }
            // Format: "John Smith" -> "Smith"
            const parts = trimmed.split(/\s+/);
            return parts[parts.length - 1];
        };

        if (authors.length > 2) {
            return `${getSurname(authors[0])} <em>et al.</em>`;
        }
        if (authors.length === 2) {
            return `${getSurname(authors[0])} & ${getSurname(authors[1])}`;
        }
        return getSurname(authors[0]);
    }
}