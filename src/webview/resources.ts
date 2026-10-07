import { resolveProjectResourcePath } from '../file-provider';
import { HostToPreviewCommand, type ResourceChangedMessage } from '../preview-messages';
import { decodeHtmlAttribute } from '../utils';

export function getResourcePaths(html: string): string[] {
    return [...new Set(Array.from(html.matchAll(/data-req-path="([^"]+)"/g), match => decodeHtmlAttribute(match[1])))];
}

/** Update only resource elements; decode/render failures do not acknowledge or retry file reads. */
export function refreshResourceElements(root: ParentNode, change: ResourceChangedMessage): Set<HTMLElement> {
    const blocks = new Set<HTMLElement>();
    for (const element of Array.from(root.querySelectorAll<HTMLElement>('img[data-req-path],canvas[data-req-path]'))) {
        if (resolveProjectResourcePath(change.baseDirectory, element.getAttribute('data-req-path')) !== change.path) {continue;}
        const block = element.closest<HTMLElement>('.latex-block');
        if (block) {blocks.add(block.closest<HTMLElement>('.latex-block-shell') ?? block);}
        if (element.tagName === 'IMG') {
            if (change.uri) {element.setAttribute('src', change.uri);}
            else {element.removeAttribute('src');}
        } else {
            // Detach the old canvas so an in-flight PDF render cannot paint over the new resource.
            const canvas = element.cloneNode(false) as HTMLCanvasElement;
            canvas.id = `resource-pdf-${crypto.randomUUID()}`;
            canvas.removeAttribute('data-rendered');
            canvas.setAttribute('data-requested', 'true');
            element.replaceWith(canvas);
            window.postMessage({ command: HostToPreviewCommand.PdfUri, id: canvas.id,
                uri: change.uri, error: change.uri ? undefined : 'PDF not found' }, window.location.origin);
        }
    }
    return blocks;
}
