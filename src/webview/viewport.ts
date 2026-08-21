interface ViewportAnchor {
    element: HTMLElement;
    top: number;
}

export const PREVIEW_RESIZE_ACTIVE_CLASS = 'snaptex-preview-resizing';

function findViewportAnchor(elements: readonly HTMLElement[]): ViewportAnchor | undefined {
    // Preview blocks are vertically ordered, so skip the offscreen prefix without scanning it.
    let low = 0;
    let high = elements.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (elements[middle].getBoundingClientRect().bottom <= 0) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    let spanningAnchor: { element: HTMLElement; top: number } | undefined;
    for (let index = low; index < elements.length; index++) {
        const element = elements[index];
        const rect = element.getBoundingClientRect();
        if (rect.top >= window.innerHeight) {break;}
        const candidate = { element, top: rect.top };
        if (rect.top >= 0) {return candidate;}
        spanningAnchor ??= candidate;
    }
    return spanningAnchor;
}

/** Keeps one visible block stationary across virtualization and pagination changes. */
export class ViewportAnchorController {
    private pinnedAnchor?: ViewportAnchor;

    pin(elements: readonly HTMLElement[]): void {
        this.pinnedAnchor = window.scrollY > 0 ? findViewportAnchor(elements) : undefined;
    }

    clear(): void {
        this.pinnedAnchor = undefined;
    }

    isPinned(): boolean {
        return this.pinnedAnchor?.element.isConnected === true;
    }

    compensatePinnedPosition(): void {
        this.preserve([], () => undefined);
    }

    preserve<T>(elements: readonly HTMLElement[], update: () => T): T {
        const anchor = this.pinnedAnchor?.element.isConnected
            ? this.pinnedAnchor
            : window.scrollY > 0 ? findViewportAnchor(elements) : undefined;

        const result = update();
        if (anchor?.element.isConnected) {
            const delta = anchor.element.getBoundingClientRect().top - anchor.top;
            if (Math.abs(delta) >= 1) {window.scrollBy(0, delta);}
        }
        return result;
    }
}
