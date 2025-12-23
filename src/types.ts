export interface PreambleData {
    macros: Record<string, string>;
    title?: string;
    author?: string;
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

    // [New] Numbering Data Update
    numbering?: {
        blocks: { [index: number]: any }; // Sparse map of blockIndex -> counts
        labels: Record<string, string>;   // Global label map
    };
}

export interface PreprocessRule {
    name: string;
    priority: number;
    apply: (text: string, renderer: any) => string;
}