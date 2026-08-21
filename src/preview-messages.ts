import type { PreviewLayoutMode, PreviewStyleSettings, RenderPayload, SourceSyncOptions } from './types';
import { isRecord } from './utils';

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

export const MAX_BLOCK_HTML_BATCH_SIZE = 4;

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

export interface RevealLineMessage extends SourceSyncOptions {
    command: typeof PreviewToHostCommand.RevealLine;
    index: number;
    ratio: number;
    viewRatio?: number;
}

export interface SyncScrollMessage extends SourceSyncOptions {
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

export interface BlockHtmlRequest {
    id: string;
    index: number;
    hash: string;
}

export interface RequestBlockHtmlMessage {
    command: typeof PreviewToHostCommand.RequestBlockHtml;
    requests: BlockHtmlRequest[];
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

interface ScrollToBlockMessage extends SourceSyncOptions {
    command: typeof HostToPreviewCommand.ScrollToBlock;
    index: number;
    ratio: number;
    anchor?: string;
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
        previewLayout: PreviewLayoutMode;
        style: PreviewStyleSettings;
    };
}

export type HostToPreviewMessage =
    | UpdateMessage
    | ScrollToBlockMessage
    | PdfUriMessage
    | BlockHtmlMessage
    | ConfigMessage;

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
    return value === undefined || isFiniteNumber(value);
}

function hasSourceSyncPosition(value: Record<string, unknown>): boolean {
    return isFiniteNumber(value.index)
        && isFiniteNumber(value.ratio)
        && isOptionalFiniteNumber(value.sourceStart)
        && isOptionalFiniteNumber(value.sourceEnd);
}

function isBlockHtmlRequest(value: unknown): value is BlockHtmlRequest {
    return isRecord(value)
        && typeof value.id === 'string'
        && value.id.length > 0
        && isFiniteNumber(value.index)
        && typeof value.hash === 'string';
}

export function isPreviewToHostMessage(value: unknown): value is PreviewToHostMessage {
    if (!isRecord(value) || typeof value.command !== 'string') {
        return false;
    }

    switch (value.command) {
        case PreviewToHostCommand.PreviewLoaded:
        case PreviewToHostCommand.PreviewLayoutChanged:
            return true;
        case PreviewToHostCommand.RevealLine:
            return hasSourceSyncPosition(value)
                && (value.anchors === undefined || (Array.isArray(value.anchors) && value.anchors.every(anchor => typeof anchor === 'string')))
                && isOptionalFiniteNumber(value.viewRatio);
        case PreviewToHostCommand.SyncScroll:
            return hasSourceSyncPosition(value);
        case PreviewToHostCommand.RequestPdf:
            return typeof value.id === 'string' && value.id.length > 0
                && typeof value.path === 'string';
        case PreviewToHostCommand.RequestBlockHtml:
            return Array.isArray(value.requests)
                && value.requests.length > 0
                && value.requests.length <= MAX_BLOCK_HTML_BATCH_SIZE
                && value.requests.every(isBlockHtmlRequest);
        default:
            return false;
    }
}

export function assertNever(value: never): never {
    throw new Error(`Unhandled SnapTeX message: ${JSON.stringify(value)}`);
}
