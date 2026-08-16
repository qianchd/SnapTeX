interface ViewportAnchor {
    element: HTMLElement;
    top: number;
}

function findViewportAnchor(elements: readonly HTMLElement[]): ViewportAnchor | undefined {
    let spanningAnchor: { element: HTMLElement; top: number } | undefined;
    for (const element of elements) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= window.innerHeight) {continue;}
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
