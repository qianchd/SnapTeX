import { PdfSyncIndex } from './pdf-sync-index';
import type { PdfSyncRequest } from './pdf-sync';

let index: Promise<PdfSyncIndex> | undefined;
self.onmessage = async ({ data }: MessageEvent<PdfSyncRequest>) => {
    try {
        if ('load' in data) {
            const { runtimeUrl, data: bytes, compressed, pdfPath, rootPath, paths } = data.load;
            index = PdfSyncIndex.open(runtimeUrl, bytes, compressed, pdfPath, rootPath, paths);
        }
        const parser = await index;
        self.postMessage({ id: data.id, result: 'query' in data ? parser?.query(data.query, data.pageHint) : true });
    } catch (error) {
        self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
    }
};
