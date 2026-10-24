export function bindToolbar(toolbar: HTMLElement, hoverZone: HTMLElement): void {
    const menus = Array.from(toolbar.querySelectorAll<HTMLDetailsElement>('.toolbar-menu'));
    let touchActivation = false;
    const closeMenus = (except?: HTMLDetailsElement): void => {
        for (const menu of menus) {
            if (menu !== except) {menu.open = false;}
        }
    };
    const hideToolbar = (): void => {
        toolbar.classList.remove('is-visible');
        closeMenus();
    };

    for (const region of [toolbar, hoverZone]) {
        region.addEventListener('pointerenter', event => {
            if (event.pointerType !== 'touch' && event.buttons === 0) {
                toolbar.classList.add('is-visible');
            }
        });
        region.addEventListener('pointerleave', event => {
            const next = event.relatedTarget as Node | null;
            if (event.pointerType !== 'touch' && !toolbar.contains(next) && !hoverZone.contains(next)) {
                hideToolbar();
            }
        });
    }

    for (const menu of menus) {
        menu.addEventListener('toggle', () => {
            if (menu.open) {closeMenus(menu);}
        });
        menu.addEventListener('pointerleave', event => {
            if (event.pointerType !== 'touch') {menu.open = false;}
        });
    }
    document.addEventListener('pointerdown', event => {
        touchActivation = event.pointerType === 'touch' && event.clientY < 44
            && !toolbar.classList.contains('is-visible')
            && !toolbar.contains(event.target as Node | null);
        if (touchActivation) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, { capture: true });
    document.addEventListener('click', event => {
        const target = event.target as Node | null;
        const revealFromTouch = event.detail > 0 && touchActivation;
        touchActivation = false;
        if (revealFromTouch) {
            event.preventDefault();
            event.stopPropagation();
        }
        if (!revealFromTouch && !toolbar.contains(target) && !hoverZone.contains(target)) {hideToolbar();}
        else {
            toolbar.classList.add('is-visible');
            if (!menus.some(menu => menu.contains(target))) {closeMenus();}
        }
    }, { capture: true });
}
