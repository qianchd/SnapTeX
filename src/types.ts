export interface SourceLocation {
    file: string;
    line: number;
}

export interface PreambleData {
    macros: Record<string, string>; // For KaTeX (existing)

    // [CHANGE] Split TikZ data into global settings and individual macros
    tikzGlobal: string; // \\usetikzlibrary, \\tikzset, \\definecolor (Always inject)
    tikzMacroMap: Map<string, string>; // Key: "\\macroName", Value: "\\def\\macroName{...}" (Inject on demand)

    title?: string;
    author?: string;
    date?: string;
}

export interface MetadataResult {
    data: PreambleData;
    cleanedText: string;
}

export interface PatchPayload {
    type: 'full' | 'patch';
    html?: string;
    start?: number;
    deleteCount?: number;
    htmls?: string[];
    shift?: number;

    // Numbering Data Update
    numbering?: {
        blocks: { [index: number]: any }; // Sparse map of blockIndex -> counts
        labels: Record<string, string>;   // Global label map
    };

    /**
     * [NEW] Dirty Blocks Map
     * Key: The block index (in the FINAL document state).
     * Value: The new HTML content for that block.
     * Purpose: Update specific blocks (like Bibliography) that are impacted by changes
     * elsewhere, without triggering a full document re-render.
     */
    dirtyBlocks?: { [index: number]: string };
}

export interface PreprocessRule {
    name: string;
    priority: number;
    apply: (text: string, renderer: any) => string;
}