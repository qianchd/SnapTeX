import * as assert from 'assert';
import { HostToPreviewCommand, type ResourceChangedMessage } from '../preview-messages';
import { getResourcePaths, refreshResourceElements } from '../webview/resources';
import { installTestGlobals } from './test-helpers';

suite('Preview resource changes', () => {
    test('updates matching images and PDFs without replacing their text blocks', () => {
        const change: ResourceChangedMessage = { command: HostToPreviewCommand.ResourceChanged,
            path: 'figures/a&b.png', baseDirectory: 'subfold', uri: 'blob:new' };
        assert.deepEqual(getResourcePaths('<img data-req-path="../figures/a&amp;b.png">'), ['../figures/a&b.png']);
        const block = { closest: () => null } as unknown as HTMLElement;
        const element = (tagName: string, path: string) => {
            const attributes = new Map([['data-req-path', path], ['src', 'old'], ['data-rendered', 'true']]);
            return {
                tagName, id: 'old', attributes,
                getAttribute: (name: string) => attributes.get(name) ?? null,
                setAttribute: (name: string, value: string) => {attributes.set(name, value);},
                removeAttribute: (name: string) => {attributes.delete(name);},
                closest: () => block,
                cloneNode: () => element(tagName, path),
                replacement: undefined as unknown,
                replaceWith(replacement: unknown) {this.replacement = replacement;}
            };
        };
        const image = element('IMG', '../figures/a&b.png');
        const unrelated = element('IMG', '../figures/other.png');
        const outside = element('IMG', '../../figures/a&b.png');
        const canvas = element('CANVAS', '../figures/a&b.pdf');
        const root = { querySelectorAll: () => [image, unrelated, outside, canvas] } as unknown as ParentNode;
        const messages: Array<{ id: string; uri?: string; error?: string }> = [];
        const restore = installTestGlobals({ window: { location: { origin: 'https://snaptex.test' },
            postMessage: (message: typeof messages[number]) => {messages.push(message);} } });
        try {
            assert.deepEqual([...refreshResourceElements(root, change)], [block]);
            assert.equal(image.getAttribute('src'), 'blob:new');
            assert.equal(unrelated.getAttribute('src'), 'old');
            assert.equal(outside.getAttribute('src'), 'old');
            assert.equal(messages.length, 0);
            const shell = {} as HTMLElement;
            Object.assign(block, { closest: () => shell });
            assert.deepEqual([...refreshResourceElements(root, change)], [shell], 'Mounted blocks must identify their shell for cache and height invalidation');
            const pdfChange = { ...change, path: 'figures/a&b.pdf' };
            refreshResourceElements(root, pdfChange);
            assert.ok(canvas.replacement, 'An old PDF render must be detached from the replacement canvas');
            assert.notEqual(messages[0].id, 'old');
            assert.equal(messages[0].uri, 'blob:new');
            refreshResourceElements(root, { ...change, uri: undefined });
            assert.equal(image.getAttribute('src'), null);
            refreshResourceElements(root, { ...pdfChange, uri: undefined });
            assert.ok(messages[1].error);
        } finally {restore();}
    });
});
