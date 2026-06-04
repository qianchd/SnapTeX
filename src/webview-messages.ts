import type { PatchPayload } from './types';

export const WebviewToExtensionCommand = {
    WebviewLoaded: 'webviewLoaded',
    RevealLine: 'revealLine',
    SyncScroll: 'syncScroll',
    RequestPdf: 'requestPdf',
    RequestBlockHtml: 'requestBlockHtml'
} as const;

export const ExtensionToWebviewCommand = {
    Update: 'update',
    UpdateBinary: 'update_binary',
    ScrollToBlock: 'scrollToBlock',
    PdfUri: 'pdfUri',
    BlockHtml: 'blockHtml',
    Config: 'config'
} as const;

export interface WebviewLoadedMessage {
    command: typeof WebviewToExtensionCommand.WebviewLoaded;
}

export interface RevealLineMessage {
    command: typeof WebviewToExtensionCommand.RevealLine;
    index: number;
    ratio: number;
    anchor?: string;
    viewRatio?: number;
}

export interface SyncScrollMessage {
    command: typeof WebviewToExtensionCommand.SyncScroll;
    index: number;
    ratio: number;
}

export interface RequestPdfMessage {
    command: typeof WebviewToExtensionCommand.RequestPdf;
    id: string;
    path: string;
}

export interface RequestBlockHtmlMessage {
    command: typeof WebviewToExtensionCommand.RequestBlockHtml;
    id: string;
    index: number;
    hash: string;
}

export type WebviewToExtensionMessage =
    | WebviewLoadedMessage
    | RevealLineMessage
    | SyncScrollMessage
    | RequestPdfMessage
    | RequestBlockHtmlMessage;

export interface UpdateMessage {
    command: typeof ExtensionToWebviewCommand.Update;
    payload: PatchPayload;
}

export interface UpdateBinaryMessage {
    command: typeof ExtensionToWebviewCommand.UpdateBinary;
    payload: PatchPayload;
    binaryData: Uint8Array | { type: 'Buffer'; data: number[] } | ArrayBuffer | number[];
}

export interface ScrollToBlockMessage {
    command: typeof ExtensionToWebviewCommand.ScrollToBlock;
    index: number;
    ratio: number;
    anchor?: string;
    auto?: boolean;
    viewRatio?: number;
}

export interface PdfUriMessage {
    command: typeof ExtensionToWebviewCommand.PdfUri;
    id: string;
    uri?: string;
    path?: string;
    error?: string;
}

export interface BlockHtmlMessage {
    command: typeof ExtensionToWebviewCommand.BlockHtml;
    id: string;
    index: number;
    hash?: string;
    html?: string;
    error?: string;
}

export interface ConfigMessage {
    command: typeof ExtensionToWebviewCommand.Config;
    config: {
        autoScrollDelay: number;
        debugMemory: boolean;
        virtualMode: boolean;
    };
}

export type ExtensionToWebviewMessage =
    | UpdateMessage
    | UpdateBinaryMessage
    | ScrollToBlockMessage
    | PdfUriMessage
    | BlockHtmlMessage
    | ConfigMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isOptionalString(value: unknown): boolean {
    return value === undefined || typeof value === 'string';
}

function isOptionalNumber(value: unknown): boolean {
    return value === undefined || typeof value === 'number';
}

export function isWebviewToExtensionMessage(value: unknown): value is WebviewToExtensionMessage {
    if (!isRecord(value) || typeof value.command !== 'string') {
        return false;
    }

    switch (value.command) {
        case WebviewToExtensionCommand.WebviewLoaded:
            return true;
        case WebviewToExtensionCommand.RevealLine:
            return typeof value.index === 'number'
                && typeof value.ratio === 'number'
                && isOptionalString(value.anchor)
                && isOptionalNumber(value.viewRatio);
        case WebviewToExtensionCommand.SyncScroll:
            return typeof value.index === 'number'
                && typeof value.ratio === 'number';
        case WebviewToExtensionCommand.RequestPdf:
            return typeof value.id === 'string'
                && typeof value.path === 'string';
        case WebviewToExtensionCommand.RequestBlockHtml:
            return typeof value.id === 'string'
                && typeof value.index === 'number'
                && typeof value.hash === 'string';
        default:
            return false;
    }
}

export function assertNever(value: never): never {
    throw new Error(`Unhandled SnapTeX message: ${JSON.stringify(value)}`);
}
