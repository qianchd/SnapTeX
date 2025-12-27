export interface PreambleData {
    macros: Record<string, string>;
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

export interface SourceLocation {
    file: string;
    line: number;
}

// --- Communication Protocol ---

/**
 * Messages sent FROM the Extension TO the Webview
 */
export type ToWebviewMessage =
    | { command: 'update'; payload: PatchPayload }
    // Add other commands if strictly needed by panel.ts in future refactoring

/**
 * Messages sent FROM the Webview TO the Extension
 */
export type FromWebviewMessage =
    | { command: 'webviewLoaded' }
    | { command: 'revealLine'; index: number; ratio: number; anchor?: boolean }
    | { command: 'syncScroll'; index: number; ratio: number };