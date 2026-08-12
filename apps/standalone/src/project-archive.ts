import type { BrowserProjectSnapshot } from './browser-project';

/** Creates a portable ZIP snapshot without depending on a host filesystem. */
export async function createProjectZip(snapshot: BrowserProjectSnapshot): Promise<Blob> {
    const { default: Zip } = await import('jszip');
    const zip = new Zip();
    for (const file of snapshot.files) {
        const content = typeof FileReader === 'undefined'
            ? new Uint8Array(await file.content.arrayBuffer())
            : file.content;
        zip.file(file.path.replace(/^\/+/, ''), content);
    }
    return zip.generateAsync({ type: 'blob', streamFiles: true });
}
