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
    // [New] Index shift value for the tail blocks
    shift?: number;
}

export interface PreprocessRule {
    name: string;
    priority: number;
    apply: (text: string, renderer: any) => string;
}