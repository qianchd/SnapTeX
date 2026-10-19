export function bindToolbar(toolbar: HTMLElement, hoverZone: HTMLElement): void {
    const menus = Array.from(toolbar.querySelectorAll<HTMLDetailsElement>('.toolbar-menu'));
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
    document.addEventListener('click', event => {
        const target = event.target as Node | null;
        if (!toolbar.contains(target) && !hoverZone.contains(target)) {hideToolbar();}
        else {
            toolbar.classList.add('is-visible');
            if (!menus.some(menu => menu.contains(target))) {closeMenus();}
        }
    });
}
