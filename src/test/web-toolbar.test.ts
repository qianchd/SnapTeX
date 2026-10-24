import * as assert from 'assert';
import { bindToolbar } from '../../apps/web/src/toolbar';
import { installTestGlobals } from './test-helpers';

class ToolbarElement extends EventTarget {
    open = false;
    readonly classList = {
        values: new Set<string>(),
        add: (name: string) => this.classList.values.add(name),
        remove: (name: string) => this.classList.values.delete(name),
        contains: (name: string) => this.classList.values.has(name)
    };
    readonly menus: ToolbarElement[] = [];
    constructor(readonly parent?: ToolbarElement) {super();}
    contains(node: unknown): boolean {
        return node === this || node instanceof ToolbarElement && this.contains(node.parent);
    }
    querySelectorAll() {return this.menus;}
    emit(type: string, properties: Record<string, unknown> = {}) {
        const event = new Event(type, { cancelable: true });
        for (const [name, value] of Object.entries(properties)) {Object.defineProperty(event, name, { value });}
        this.dispatchEvent(event);
        return event;
    }
}

suite('Web toolbar', () => {
    test('shares hover, pen and touch activation while preserving menu interaction', () => {
        const toolbar = new ToolbarElement();
        const zone = new ToolbarElement();
        const document = new ToolbarElement();
        const menus = [new ToolbarElement(toolbar), new ToolbarElement(toolbar)];
        toolbar.menus.push(...menus);
        const visible = () => toolbar.classList.values.has('is-visible');
        const restore = installTestGlobals({ document });
        try {
            bindToolbar(toolbar as unknown as HTMLElement, zone as unknown as HTMLElement);
            assert.equal(visible(), false);
            for (const pointerType of ['mouse', 'pen']) {
                zone.emit('pointerenter', { pointerType, buttons: 1 });
                assert.equal(visible(), false, 'Contact alone must not count as hover');
                zone.emit('pointerenter', { pointerType, buttons: 0 });
                assert.equal(visible(), true);
                zone.emit('pointerleave', { pointerType, relatedTarget: toolbar });
                assert.equal(visible(), true, 'Crossing into the toolbar must not close it');
                menus[0].open = true;
                toolbar.emit('pointerleave', { pointerType, relatedTarget: null });
                assert.equal(visible(), false);
                assert.equal(menus[0].open, false);
            }
            zone.emit('pointerenter', { pointerType: 'touch', buttons: 0 });
            assert.equal(visible(), false);
            document.emit('click', { target: zone });
            assert.equal(visible(), true);
            for (const menu of menus) {
                menu.open = true;
                menu.emit('toggle');
                assert.equal(menus.filter(menu => menu.open).length, 1);
            }
            menus[1].emit('pointerleave', { pointerType: 'touch' });
            toolbar.emit('pointerleave', { pointerType: 'touch' });
            document.emit('click', { target: menus[1] });
            assert.equal(visible() && menus[1].open, true, 'Lifting a finger must keep controls usable');
            document.emit('click');
            assert.equal(visible(), false);
            assert.ok(menus.every(menu => !menu.open));
            const content = new ToolbarElement(document);
            for (const pointerType of ['mouse', 'pen', 'touch']) {
                const down = document.emit('pointerdown', { pointerType, target: content, clientY: 43 });
                const click = document.emit('click', { target: content, clientY: 45, detail: 1 });
                assert.equal(visible(), pointerType === 'touch');
                assert.equal(down.defaultPrevented, pointerType === 'touch', 'A toolbar tap must not focus the editor underneath');
                assert.equal(click.defaultPrevented, pointerType === 'touch', 'Releasing just outside the activation area must not activate content underneath');
            }
            document.emit('click', { target: content, clientY: 30, detail: 1 });
            assert.equal(visible(), false, 'Tapping content while the toolbar is open still dismisses it');
            document.emit('click', { target: content, clientY: 30, detail: 1 });
            assert.equal(visible(), false, 'A click without a fresh touch must not reopen the toolbar');
            document.emit('pointerdown', { pointerType: 'touch', target: content, clientY: 44 });
            document.emit('click', { target: content, clientY: 44, detail: 1 });
            assert.equal(visible(), false, 'Touches below the activation area remain content interaction');
        } finally {restore();}
    });
});
