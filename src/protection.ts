/**
 * Protection Manager
 * Handles the creation and resolution of protected content tokens.
 * Supports recursive resolution to handle nested protections (e.g., refs inside math).
 */
export class ProtectionManager {
    private storage: Map<string, string> = new Map();
    private counter: number = 0;

    // Use a distinct pattern unlikely to occur in user text.
    // Format: XSNAP:{namespace}:{id}Y
    // We use Halfwidth and Fullwidth Forms/Block Elements characters or just obscure brackets X Y
    private readonly tokenPattern = /XSNAP:([a-zA-Z0-9_-]+):(\d+)Y/g;

    /**
     * Registers content to be protected and returns a token.
     * @param namespace Semantic label for debugging (e.g., 'math', 'ref')
     * @param content The content to protect (usually HTML)
     */
    public protect(namespace: string, content: string): string {
        const id = this.counter++;
        const token = `XSNAP:${namespace}:${id}Y`;
        this.storage.set(token, content);
        return token;
    }

    /**
     * Recursively resolves tokens in the text until no tokens remain.
     * This ensures that if a protected block (like Math) contains another token (like Ref),
     * the inner token is also resolved.
     */
    public resolve(text: string): string {
        let currentText = text;
        let depth = 0;
        const maxDepth = 15;

        // Matches: <p> TOKEN </p>  OR  TOKEN
        // This handles cases where Markdown-it wraps our block tokens in paragraphs
        const resolvePattern = /<p>\s*(XSNAP:[a-zA-Z0-9_-]+:\d+Y)\s*<\/p>|(XSNAP:[a-zA-Z0-9_-]+:\d+Y)/g;

        while (this.tokenPattern.test(currentText) && depth < maxDepth) {
            this.tokenPattern.lastIndex = 0;
            currentText = currentText.replace(resolvePattern, (fullMatch, pWrappedToken, bareToken) => {
                // Determine which group matched
                const token = pWrappedToken || bareToken;
                const val = this.storage.get(token);
                // If content exists, return it (stripping <p> if it was wrapped). Otherwise keep original.
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