import * as vscode from 'vscode';

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
}

export interface PreprocessRule {
    name: string;
    priority: number; // 增加优先级：数字越小，越先执行
    apply: (text: string, renderer: any) => string;
}