import type { PdfSyncQuery, PdfSyncResult } from './browser-project';

export interface PdfSyncData {
    runtimeUrl: string;
    data: Uint8Array;
    compressed: boolean;
    pdfPath: string;
    rootPath: string;
    paths: readonly string[];
}

export type PdfSyncRequest = { id: number } & (
    { load: PdfSyncData }
    | { query: PdfSyncQuery; pageHint?: number }
);

/** One parser worker per open PDF. Closing it releases the native tree and WASM heap. */
export class PdfSync {
    private worker?: Worker;
    private readonly ready: Promise<unknown>;
    private nextId = 0;
    private closed = false;
    private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

    constructor(workerUrl: URL, data: Promise<PdfSyncData>) {
        this.ready = data.then(load => {
            if (this.closed) {throw new Error('PDF was closed.');}
            const worker = this.worker = new Worker(workerUrl);
            worker.onmessage = ({ data }: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
                const request = this.pending.get(data.id);
                this.pending.delete(data.id);
                if (data.error) {request?.reject(new Error(data.error));}
                else {request?.resolve(data.result);}
            };
            worker.onerror = event => this.close(new Error(event.message || 'SyncTeX worker failed.'));
            return this.request({ load }, [load.data.buffer as ArrayBuffer]);
        });
        // Sidecar failure must not prevent viewing the PDF; manual sync reports this rejection.
        void this.ready.catch(error => this.close(error));
    }

    async query(query: PdfSyncQuery, pageHint = 0): Promise<PdfSyncResult | undefined> {
        await this.ready;
        return this.request({ query, pageHint }) as Promise<PdfSyncResult | undefined>;
    }

    private request(message: object, transfer: Transferable[] = []): Promise<unknown> {
        if (this.closed) {return Promise.reject(new Error('PDF was closed.'));}
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker!.postMessage({ ...message, id }, transfer);
        });
    }

    close(error = new Error('PDF was closed.')): void {
        this.closed = true;
        this.worker?.terminate();
        for (const request of this.pending.values()) {request.reject(error);}
        this.pending.clear();
    }
}
