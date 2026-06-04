/**
 * Stores renderer-generated HTML behind temporary text tokens while Markdown-it
 * processes user text with raw HTML disabled.
 *
 * Rules should call protectHtml for any trusted HTML they create. The renderer
 * resolves the tokens after Markdown rendering, including nested tokens.
 */
export class ProtectionManager {
    private storage: Map<string, string> = new Map();
    private counter: number = 0;

    private readonly tokenPattern = /XSNAP:([a-zA-Z0-9_-]+):(\d+)Y/g;

    /**
     * Registers content to be protected and returns a token.
     */
    public protect(namespace: string, content: string): string {
        const id = this.counter++;
        const token = `XSNAP:${namespace}:${id}Y`;
        this.storage.set(token, content);
        return token;
    }

    /**
     * Resolves bare or paragraph-wrapped protection tokens until no nested tokens remain.
     */
    public resolve(text: string): string {
        let currentText = text;
        let depth = 0;
        const maxDepth = 15;

        const resolvePattern = /<p>\s*(XSNAP:[a-zA-Z0-9_-]+:\d+Y)\s*<\/p>|(XSNAP:[a-zA-Z0-9_-]+:\d+Y)/g;

        while (this.tokenPattern.test(currentText) && depth < maxDepth) {
            this.tokenPattern.lastIndex = 0;
            currentText = currentText.replace(resolvePattern, (fullMatch, pWrappedToken, bareToken) => {
                const token = pWrappedToken || bareToken;
                const val = this.storage.get(token);
                return val !== undefined ? val : fullMatch;
            });
            depth++;
        }
        return currentText;
    }

    public reset() {
        this.storage.clear();
        this.counter = 0;
    }
}
