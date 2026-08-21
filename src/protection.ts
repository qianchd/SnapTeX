import type { ProtectedHtmlMode } from './types';

interface ProtectedHtmlEntry {
    content: string;
    mode: ProtectedHtmlMode;
}

const TOKEN_PATTERN = /XSNAP:([a-zA-Z0-9_-]+):(\d+)Y/;
const RESOLVE_PATTERN = /<p>\s*(XSNAP:[a-zA-Z0-9_-]+:\d+Y)\s*<\/p>|(XSNAP:[a-zA-Z0-9_-]+:\d+Y)/g;

/**
 * Stores renderer-generated HTML behind temporary text tokens while Markdown-it
 * processes user text with raw HTML disabled.
 *
 * Rules should call protectHtml for any trusted HTML they create. The renderer
 * resolves the tokens after Markdown rendering, including nested tokens.
 */
export class ProtectionManager {
    private readonly storage = new Map<string, ProtectedHtmlEntry>();
    private counter = 0;

    /**
     * Registers content to be protected and returns a token.
     */
    public protect(namespace: string, content: string, mode: ProtectedHtmlMode = 'block'): string {
        const id = this.counter++;
        const token = `XSNAP:${namespace}:${id}Y`;
        this.storage.set(token, { content, mode });
        return token;
    }

    /**
     * Resolves bare or paragraph-wrapped protection tokens until no nested tokens remain.
     */
    public resolve(text: string): string {
        let currentText = text;
        for (let depth = 0; depth < 15 && TOKEN_PATTERN.test(currentText); depth++) {
            currentText = currentText.replace(RESOLVE_PATTERN, (fullMatch, pWrappedToken, bareToken) => {
                const token = pWrappedToken || bareToken;
                const entry = this.storage.get(token);
                if (!entry) { return fullMatch; }
                if (pWrappedToken && entry.mode === 'inline') {
                    return `<p>${entry.content}</p>`;
                }
                return entry.content;
            });
        }
        return currentText;
    }

    public reset() {
        this.storage.clear();
        this.counter = 0;
    }
}
