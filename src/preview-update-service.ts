import { LatexDocument } from './document';
import type { IFileProvider } from './file-provider';
import type { SmartRenderer } from './renderer';
import type { RenderPayload, UriLike } from './types';

export interface PreviewRenderOptions {
    deferFullHtml: boolean;
    trace?: (label: string) => void;
    transformHtml?: (html: string) => string;
}

/**
 * Coordinates document parsing and renderer state without depending on a host UI.
 */
export class PreviewUpdateService<TUri extends UriLike = UriLike> {
    private readonly document: LatexDocument<TUri>;

    constructor(fileProvider: IFileProvider<TUri>, private readonly renderer: SmartRenderer) {
        this.document = new LatexDocument(fileProvider);
    }

    public resetState() {
        this.renderer.resetState();
    }

    public renderBlockByIndex(index: number) {
        return this.renderer.renderBlockByIndex(index);
    }

    public async render(uri: TUri, text: string, options: PreviewRenderOptions): Promise<RenderPayload> {
        const parseResult = await this.document.parse(uri, text, { trace: options.trace });
        options.trace?.('after parse');

        this.document.applyResult(parseResult);
        const payload = this.renderer.render(this.document, { deferFullHtml: options.deferFullHtml });
        options.trace?.('after render');

        this.document.releaseTextContent();
        parseResult.bodyText = "";
        parseResult.blockSpans = [];
        parseResult.blockHashes = [];

        if (payload.htmls && options.transformHtml) {
            for (let index = 0; index < payload.htmls.length; index++) {
                payload.htmls[index] = options.transformHtml(payload.htmls[index]);
            }
            options.trace?.('after transformHtml');
        }

        return payload;
    }
}
