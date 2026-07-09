import type { RenderPayload } from './types';

/**
 * Typed message contract between a preview host and the preview runtime.
 *
 * Hosts validate incoming preview messages with isPreviewToHostMessage before
 * dispatching commands. Outgoing messages are typed at compile time.
 */
export const PreviewToHostCommand = {
    PreviewLoaded: 'previewLoaded',
    RevealLine: 'revealLine',
    SyncScroll: 'syncScroll',
    PreviewLayoutChanged: 'previewLayoutChanged',
    RequestPdf: 'requestPdf',
    RequestBlockHtml: 'requestBlockHtml'
} as const;

export const HostToPreviewCommand = {
    Update: 'update',
    ScrollToBlock: 'scrollToBlock',
    PdfUri: 'pdfUri',
    BlockHtml: 'blockHtml',
    Config: 'config'
} as const;

interface PreviewLoadedMessage {
    command: typeof PreviewToHostCommand.PreviewLoaded;
}

export interface RevealLineMessage {
    command: typeof PreviewToHostCommand.RevealLine;
    index: number;
    ratio: number;
    anchors?: string[];
    sourceStart?: number;
    sourceEnd?: number;
    viewRatio?: number;
}

interface SyncScrollMessage {
    command: typeof PreviewToHostCommand.SyncScroll;
    index: number;
    ratio: number;
}

interface PreviewLayoutChangedMessage {
    command: typeof PreviewToHostCommand.PreviewLayoutChanged;
}

export interface RequestPdfMessage {
    command: typeof PreviewToHostCommand.RequestPdf;
    id: string;
    path: string;
}

export interface RequestBlockHtmlMessage {
    command: typeof PreviewToHostCommand.RequestBlockHtml;
    id: string;
    index: number;
    hash: string;
}

export type PreviewToHostMessage =
    | PreviewLoadedMessage
    | RevealLineMessage
    | SyncScrollMessage
    | PreviewLayoutChangedMessage
    | RequestPdfMessage
    | RequestBlockHtmlMessage;

interface UpdateMessage {
    command: typeof HostToPreviewCommand.Update;
    payload: RenderPayload;
}

interface ScrollToBlockMessage {
    command: typeof HostToPreviewCommand.ScrollToBlock;
    index: number;
    ratio: number;
    anchor?: string;
    sourceStart?: number;
    sourceEnd?: number;
    auto?: boolean;
    viewRatio?: number;
}

interface PdfUriMessage {
    command: typeof HostToPreviewCommand.PdfUri;
    id: string;
    uri?: string;
    path?: string;
    error?: string;
}

interface BlockHtmlMessage {
    command: typeof HostToPreviewCommand.BlockHtml;
    id: string;
    index: number;
    hash?: string;
    html?: string;
    error?: string;
}

interface ConfigMessage {
    command: typeof HostToPreviewCommand.Config;
    config: {
        autoScrollDelay: number;
        debugMemory: boolean;
        virtualMode: boolean;
    };
}

export type HostToPreviewMessage =
    | UpdateMessage
    | ScrollToBlockMessage
    | PdfUriMessage
    | BlockHtmlMessage
    | ConfigMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isOptionalType(value: unknown, type: 'string' | 'number'): boolean {
    return value === undefined || typeof value === type;
}

export function isPreviewToHostMessage(value: unknown): value is PreviewToHostMessage {
    if (!isRecord(value) || typeof value.command !== 'string') {
        return false;
    }

    switch (value.command) {
        case PreviewToHostCommand.PreviewLoaded:
            return true;
        case PreviewToHostCommand.RevealLine:
            return typeof value.index === 'number'
                && typeof value.ratio === 'number'
                && (value.anchors === undefined || (Array.isArray(value.anchors) && value.anchors.every(anchor => typeof anchor === 'string')))
                && isOptionalType(value.sourceStart, 'number')
                && isOptionalType(value.sourceEnd, 'number')
                && isOptionalType(value.viewRatio, 'number');
        case PreviewToHostCommand.SyncScroll:
            return typeof value.index === 'number'
                && typeof value.ratio === 'number';
        case PreviewToHostCommand.PreviewLayoutChanged:
            return true;
        case PreviewToHostCommand.RequestPdf:
            return typeof value.id === 'string'
                && typeof value.path === 'string';
        case PreviewToHostCommand.RequestBlockHtml:
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
