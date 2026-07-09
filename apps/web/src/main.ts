import { createStandaloneSnapTeXApp, DEFAULT_STANDALONE_PREVIEW_SETTINGS, type StandaloneHost, type StandalonePreviewSettings } from '../../standalone/src/app';
import type { BackendMode } from '../../../src/types';
import {
    createProjectTree,
    fileInputPath,
    isProjectFile,
    isTexFile,
    projectFolderPaths,
    projectFileFromFile,
    projectFileFromHandle,
    readDirectoryHandle,
    type BrowserDirectoryHandle,
    type BrowserFileHandle,
    type ProjectTreeNode
} from '../../standalone/src/browser-project';
import type { BrowserProjectFile } from '../../standalone/src/browser-file-provider';
import { createStandaloneDemoProjectFiles } from '../../standalone/src/demo-project';

const RESIZE_WIDTH_STEP_PX = 10;
const RESIZE_FRAME_INTERVAL_MS = 30;

interface BrowserFilePickerWindow extends Window {
    showOpenFilePicker?: (options?: {
        multiple?: boolean;
        types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<BrowserFileHandle[]>;
    showDirectoryPicker?: () => Promise<BrowserDirectoryHandle>;
}

let explorerCollapsed = false;
const expandedFolders = new Set<string>();
type WebTheme = 'light' | 'dark' | 'blue' | 'rose';
type BooleanPreviewSetting = 'livePreview' | 'autoScrollSync' | 'virtualMode' | 'debugMemory';
type NumberPreviewSetting = 'renderDelayMs' | 'autoScrollDelayMs';
type BooleanSettingControl = 'livePreviewToggle' | 'autoScrollToggle' | 'virtualModeToggle' | 'debugMemoryToggle';
type NumberSettingControl = 'renderDelayInput' | 'autoScrollDelayInput';

const BOOLEAN_SETTING_CONTROLS: ReadonlyArray<[BooleanSettingControl, BooleanPreviewSetting]> = [
    ['livePreviewToggle', 'livePreview'],
    ['autoScrollToggle', 'autoScrollSync'],
    ['virtualModeToggle', 'virtualMode'],
    ['debugMemoryToggle', 'debugMemory']
];

const NUMBER_SETTING_CONTROLS: ReadonlyArray<[NumberSettingControl, NumberPreviewSetting, number]> = [
    ['renderDelayInput', 'renderDelayMs', DEFAULT_STANDALONE_PREVIEW_SETTINGS.renderDelayMs],
    ['autoScrollDelayInput', 'autoScrollDelayMs', DEFAULT_STANDALONE_PREVIEW_SETTINGS.autoScrollDelayMs]
];

function getElement<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}

function requireElement<T extends HTMLElement>(id: string): T {
    const element = getElement<T>(id);
    if (!element) {
        throw new Error(`Missing web control #${id}.`);
    }
    return element;
}

function readControls() {
    return {
        activePathLabel: requireElement('active-path-label'),
        rootPathLabel: requireElement('root-path-label'),
        status: requireElement('project-status'),
        projectFiles: requireElement('project-files'),
        projectDiagnostics: requireElement('project-diagnostics'),
        toggleExplorerButton: requireElement('toggle-explorer-button'),
        openFileButton: requireElement('open-file-button'),
        openFolderButton: requireElement('open-folder-button'),
        saveButton: requireElement('save-button'),
        setRootButton: requireElement<HTMLButtonElement>('set-root-button'),
        settingsButton: requireElement('settings-button'),
        settingsMenu: requireElement('settings-menu'),
        showExplorerToggle: requireElement<HTMLInputElement>('show-explorer-toggle'),
        showDiagnosticsToggle: requireElement<HTMLInputElement>('show-diagnostics-toggle'),
        livePreviewToggle: requireElement<HTMLInputElement>('live-preview-toggle'),
        autoScrollToggle: requireElement<HTMLInputElement>('auto-scroll-toggle'),
        virtualModeToggle: requireElement<HTMLInputElement>('virtual-mode-toggle'),
        debugMemoryToggle: requireElement<HTMLInputElement>('debug-memory-toggle'),
        backendModeSelect: requireElement<HTMLSelectElement>('backend-mode-select'),
        renderDelayInput: requireElement<HTMLInputElement>('render-delay-input'),
        autoScrollDelayInput: requireElement<HTMLInputElement>('auto-scroll-delay-input'),
        themeSelect: requireElement<HTMLSelectElement>('theme-select'),
        openFileInput: requireElement<HTMLInputElement>('open-file-input'),
        openFolderInput: requireElement<HTMLInputElement>('open-folder-input')
    };
}

let controls: ReturnType<typeof readControls> | undefined;

function getControls(): ReturnType<typeof readControls> {
    controls ??= readControls();
    return controls;
}

function enableSplitPaneResize(splitter: HTMLElement): void {
    const shell = document.getElementById('workspace');
    const editorPane = document.getElementById('editor-pane');
    const contentRoot = document.getElementById('content-root');
    if (!shell || !editorPane) {
        return;
    }

    let dragState: {
        editorLeft: number;
        maxWidth: number;
        availableWidth: number;
        minEditorWidth: number;
        minPreviewWidth: number;
        splitterWidth: number;
        previewFontMin: number;
        previewFontMax: number;
        previewFontScale: number;
        nextWidth: number;
        appliedWidth: number;
        lastAppliedAt: number;
        animationFrame: number | undefined;
    } | undefined;

    const cssNumber = (name: string): number => {
        const value = Number.parseFloat(getComputedStyle(shell).getPropertyValue(name));
        return Number.isFinite(value) ? value : 0;
    };

    const clampedEditorWidth = (clientX: number, state: NonNullable<typeof dragState>): number =>
        Math.round(Math.min(state.maxWidth, Math.max(state.minEditorWidth, clientX - state.editorLeft)));

    const applyEditorWidth = (state: NonNullable<typeof dragState>, width: number): void => {
        if (width !== state.appliedWidth) {
            shell.style.setProperty('--snaptex-web-editor-width', `${width}px`);
            state.appliedWidth = width;
        }
        const previewWidth = Math.max(state.minPreviewWidth, state.availableWidth - width - state.splitterWidth);
        const previewFontSize = Math.min(
            state.previewFontMax,
            Math.max(state.previewFontMin, previewWidth * state.previewFontScale / 100)
        );
        contentRoot?.style.setProperty('--snaptex-web-resize-preview-font-size', `${previewFontSize.toFixed(2)}px`);
    };

    const scheduleEditorWidth = (clientX: number): void => {
        if (!dragState) {
            return;
        }

        dragState.nextWidth = clampedEditorWidth(clientX, dragState);
        if (dragState.animationFrame !== undefined) {
            return;
        }

        dragState.animationFrame = window.requestAnimationFrame(() => {
            if (!dragState) {
                return;
            }
            const now = performance.now();
            const widthDelta = Math.abs(dragState.nextWidth - dragState.appliedWidth);
            dragState.animationFrame = undefined;
            if (widthDelta >= RESIZE_WIDTH_STEP_PX && now - dragState.lastAppliedAt >= RESIZE_FRAME_INTERVAL_MS) {
                applyEditorWidth(dragState, dragState.nextWidth);
                dragState.lastAppliedAt = now;
            } else if (widthDelta >= RESIZE_WIDTH_STEP_PX) {
                scheduleEditorWidth(dragState.editorLeft + dragState.nextWidth);
            }
        });
    };

    const startResize = (event: PointerEvent): void => {
        const shellRect = shell.getBoundingClientRect();
        const editorRect = editorPane.getBoundingClientRect();
        const availableWidth = shellRect.right - editorRect.left;
        const minEditorWidth = cssNumber('--snaptex-web-min-editor-width');
        const minPreviewWidth = cssNumber('--snaptex-web-min-preview-width');
        const splitterWidth = cssNumber('--snaptex-web-splitter-width');
        dragState = {
            editorLeft: editorRect.left,
            maxWidth: Math.max(minEditorWidth, availableWidth - minPreviewWidth - splitterWidth),
            availableWidth,
            minEditorWidth,
            minPreviewWidth,
            splitterWidth,
            previewFontMin: cssNumber('--snaptex-preview-font-min'),
            previewFontMax: cssNumber('--snaptex-preview-font-max'),
            previewFontScale: cssNumber('--snaptex-preview-font-scale'),
            nextWidth: Math.round(editorRect.width),
            appliedWidth: Math.round(editorRect.width),
            lastAppliedAt: 0,
            animationFrame: undefined
        };
        applyEditorWidth(dragState, dragState.appliedWidth);

        splitter.setPointerCapture(event.pointerId);
        document.body.classList.add('is-resizing-split');
        scheduleEditorWidth(event.clientX);
        event.preventDefault();
    };

    const endResize = (event: PointerEvent): void => {
        if (dragState?.animationFrame !== undefined) {
            window.cancelAnimationFrame(dragState.animationFrame);
            applyEditorWidth(dragState, dragState.nextWidth);
        }
        dragState = undefined;
        contentRoot?.style.removeProperty('--snaptex-web-resize-preview-font-size');
        document.body.classList.remove('is-resizing-split');
        if (splitter.hasPointerCapture(event.pointerId)) {
            splitter.releasePointerCapture(event.pointerId);
        }
    };

    splitter.addEventListener('pointerdown', startResize);
    splitter.addEventListener('pointermove', event => {
        if (splitter.hasPointerCapture(event.pointerId)) {
            scheduleEditorWidth(event.clientX);
        }
    });
    splitter.addEventListener('pointerup', endResize);
    splitter.addEventListener('pointercancel', endResize);
}

function setStatus(message: string): void {
    getControls().status.textContent = message;
}

function reportFailure(action: string, error: unknown): void {
    setStatus(`${action} failed: ${error instanceof Error ? error.message : String(error)}`);
}

async function loadProject(host: StandaloneHost, files: readonly BrowserProjectFile[]): Promise<void> {
    const rootPath = await host.loadProjectFiles(files);
    if (!rootPath) {
        setStatus('No TeX file found.');
        return;
    }

    expandedFolders.clear();
    projectFolderPaths(host.getProjectTextPaths()).forEach(path => expandedFolders.add(path));
    renderProjectState(host);
    setStatus(`Opened ${rootPath} (${files.length} files)`);
}

function renderProjectState(host: StandaloneHost): void {
    renderChromeState(host);
    renderProjectFiles(host);
    renderProjectDiagnostics(host);
}

function renderChromeState(host: StandaloneHost): void {
    const controls = getControls();
    const activePath = host.getActivePath();
    const rootPath = host.getRootPath();
    const activePathText = `${activePath}${host.isDirty(activePath) ? ' *' : ''}`;
    controls.activePathLabel.textContent = activePathText;
    controls.activePathLabel.title = activePathText;
    controls.rootPathLabel.textContent = `root: ${rootPath}`;
    controls.rootPathLabel.title = rootPath;
    syncSettingsControls(host);

    const canSetRoot = isTexFile(activePath) && activePath !== rootPath;
    controls.setRootButton.disabled = !canSetRoot;
    controls.setRootButton.title = canSetRoot ? `Set ${activePath} as preview root` : 'Current TeX file is already the preview root';
}

function renderProjectFiles(host: StandaloneHost): void {
    const rows = createProjectTree(host.getProjectTextPaths())
        .children
        .flatMap(node => renderProjectTreeNode(host, node, 0));
    getControls().projectFiles.replaceChildren(...rows);
}

function renderProjectTreeNode(host: StandaloneHost, node: ProjectTreeNode, depth: number): HTMLElement[] {
    const row = document.createElement('div');
    row.className = 'project-tree-row';
    row.style.paddingLeft = `${depth * 12 + 4}px`;

    if (node.kind === 'folder') {
        const expanded = expandedFolders.has(node.path);
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'project-folder-toggle';
        toggle.textContent = expanded ? 'v' : '>';
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.addEventListener('click', () => {
            if (expanded) {
                expandedFolders.delete(node.path);
            } else {
                expandedFolders.add(node.path);
            }
            renderProjectFiles(host);
        });

        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'project-folder-label';
        label.textContent = node.name;
        label.title = node.path;
        label.addEventListener('click', () => toggle.click());

        row.append(toggle, label, document.createElement('span'));
        return expanded ? [row, ...node.children.flatMap(child => renderProjectTreeNode(host, child, depth + 1))] : [row];
    }

    const spacer = document.createElement('span');
    const openButton = document.createElement('button');
    const badge = document.createElement('span');
    openButton.type = 'button';
    openButton.className = 'project-file-open project-file-name';
    openButton.textContent = node.name;
    openButton.title = node.path;
    openButton.addEventListener('click', () => {
        host.openEditorFile(node.path)
            .then(() => {
                setStatus(`Editing ${node.path}`);
            })
            .catch(error => reportFailure('Open file', error));
    });
    badge.className = 'project-file-badge';
    badge.textContent = node.path === host.getRootPath() ? 'root' : '';

    row.dataset.active = String(node.path === host.getActivePath());
    row.dataset.dirty = String(host.isDirty(node.path));
    row.dataset.root = String(node.path === host.getRootPath());
    row.append(spacer, openButton, badge);
    return [row];
}

function renderProjectDiagnostics(host: StandaloneHost): void {
    const panel = getControls().projectDiagnostics;
    const diagnostics = host.getDiagnostics();
    if (diagnostics.length === 0) {
        panel.replaceChildren();
        return;
    }

    const list = document.createElement('ul');
    list.replaceChildren(...diagnostics.map(message => {
        const item = document.createElement('li');
        item.textContent = message;
        return item;
    }));
    panel.replaceChildren(list);
}

async function openSingleFile(host: StandaloneHost, input: HTMLInputElement): Promise<void> {
    const pickerWindow = window as BrowserFilePickerWindow;
    if (pickerWindow.showOpenFilePicker) {
        const [handle] = await pickerWindow.showOpenFilePicker({
            multiple: false,
            types: [{
                description: 'LaTeX files',
                accept: { 'text/plain': ['.tex'] }
            }]
        });
        if (handle) {
            await loadProject(host, [await projectFileFromHandle(handle, `/${handle.name}`)]);
        }
        return;
    }

    input.click();
}

async function openFolder(host: StandaloneHost, input: HTMLInputElement): Promise<void> {
    const pickerWindow = window as BrowserFilePickerWindow;
    if (pickerWindow.showDirectoryPicker) {
        const directory = await pickerWindow.showDirectoryPicker();
        await loadProject(host, await readDirectoryHandle(directory));
        return;
    }

    input.click();
}

function downloadText(path: string, text: string): void {
    const blob = new Blob([text], { type: 'text/x-tex;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = path.split('/').pop() || 'main.tex';
    link.click();
    URL.revokeObjectURL(url);
}

async function saveActiveFile(host: StandaloneHost): Promise<void> {
    const result = await host.saveCurrentText();
    if (!host.getSettings().livePreview) {
        await host.renderCurrentText();
    }
    if (result.wroteToSource) {
        setStatus(`Saved ${result.path}`);
        return;
    }

    downloadText(result.path, result.text);
    setStatus(`Downloaded ${result.path}`);
}

function bindSaveShortcut(host: StandaloneHost): void {
    document.addEventListener('keydown', event => {
        const isSave = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's';
        if (!isSave) {
            return;
        }
        event.preventDefault();
        saveActiveFile(host).catch(error => reportFailure('Save', error));
    }, { capture: true });
}

async function setActiveFileAsRoot(host: StandaloneHost): Promise<void> {
    const path = host.getActivePath();
    if (!isTexFile(path) || path === host.getRootPath()) {
        return;
    }

    await host.setPreviewRoot(path);
    setStatus(`Preview root ${path}`);
}

function setExplorerCollapsed(collapsed: boolean): void {
    explorerCollapsed = collapsed;
    document.body.dataset.explorerCollapsed = String(collapsed);
    const controls = getControls();
    controls.toggleExplorerButton.setAttribute('aria-expanded', String(!collapsed));
    controls.showExplorerToggle.checked = !collapsed;
}

function setDiagnosticsVisible(visible: boolean): void {
    document.body.dataset.diagnosticsVisible = String(visible);
    getControls().showDiagnosticsToggle.checked = visible;
}

function setInputValue(input: HTMLInputElement, value: number): void {
    if (document.activeElement !== input) {
        input.value = String(value);
    }
}

function readClampedNumber(input: HTMLInputElement, fallback: number): number {
    const value = Number(input.value);
    const min = Number(input.min || 0);
    const max = Number(input.max || value);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function setTheme(theme: WebTheme): void {
    document.body.dataset.theme = theme;
    getControls().themeSelect.value = theme;
}

function syncSettingsControls(host: StandaloneHost): void {
    const settings = host.getSettings();
    const controls = getControls();
    for (const [controlName, setting] of BOOLEAN_SETTING_CONTROLS) {
        controls[controlName].checked = settings[setting];
    }
    controls.backendModeSelect.value = settings.backendMode;
    for (const [controlName, setting] of NUMBER_SETTING_CONTROLS) {
        setInputValue(controls[controlName], settings[setting]);
    }
}

function bindProjectControls(host: StandaloneHost): void {
    const controls = getControls();
    const setSettingsOpen = (open: boolean): void => {
        controls.settingsButton.setAttribute('aria-expanded', String(open));
        controls.settingsMenu.hidden = !open;
    };
    const bindToggleSetting = (input: HTMLInputElement, setting: BooleanPreviewSetting): void => {
        input.addEventListener('change', () => host.updateSettings({ [setting]: input.checked } as Partial<StandalonePreviewSettings>));
    };
    const bindNumberSetting = (input: HTMLInputElement, setting: NumberPreviewSetting, fallback: number): void => {
        input.addEventListener('change', () => host.updateSettings({ [setting]: readClampedNumber(input, fallback) } as Partial<StandalonePreviewSettings>));
    };

    controls.toggleExplorerButton.addEventListener('click', () => {
        setExplorerCollapsed(!explorerCollapsed);
    });
    controls.openFileButton.addEventListener('click', () => {
        openSingleFile(host, controls.openFileInput).catch(error => reportFailure('Open', error));
    });
    controls.openFolderButton.addEventListener('click', () => {
        openFolder(host, controls.openFolderInput).catch(error => reportFailure('Open', error));
    });
    controls.saveButton.addEventListener('click', () => {
        saveActiveFile(host).catch(error => reportFailure('Save', error));
    });
    bindSaveShortcut(host);
    controls.setRootButton.addEventListener('click', () => {
        setActiveFileAsRoot(host).catch(error => reportFailure('Set root', error));
    });
    controls.settingsButton.addEventListener('click', () => {
        setSettingsOpen(controls.settingsButton.getAttribute('aria-expanded') !== 'true');
    });
    controls.showExplorerToggle.addEventListener('change', () => {
        setExplorerCollapsed(!controls.showExplorerToggle.checked);
    });
    controls.showDiagnosticsToggle.addEventListener('change', () => {
        setDiagnosticsVisible(controls.showDiagnosticsToggle.checked);
    });
    for (const [controlName, setting] of BOOLEAN_SETTING_CONTROLS) {
        bindToggleSetting(controls[controlName], setting);
    }
    controls.backendModeSelect.addEventListener('change', () => {
        host.updateSettings({ backendMode: controls.backendModeSelect.value as BackendMode });
    });
    for (const [controlName, setting, fallback] of NUMBER_SETTING_CONTROLS) {
        bindNumberSetting(controls[controlName], setting, fallback);
    }
    controls.themeSelect.addEventListener('change', () => {
        setTheme(controls.themeSelect.value as WebTheme);
    });
    document.addEventListener('click', event => {
        const target = event.target as Node | null;
        if (target && !controls.settingsButton.contains(target) && !controls.settingsMenu.contains(target)) {
            setSettingsOpen(false);
        }
    });

    controls.openFileInput.addEventListener('change', () => {
        const file = controls.openFileInput.files?.[0];
        if (file) {
            loadProject(host, [projectFileFromFile(file, `/${file.name}`)])
                .catch(error => reportFailure('Open', error));
        }
        controls.openFileInput.value = '';
    });
    controls.openFolderInput.addEventListener('change', () => {
        const files = Array.from(controls.openFolderInput.files ?? [])
            .map(file => ({ file, path: fileInputPath(file) }))
            .filter(({ path }) => isProjectFile(path));
        loadProject(host, files.map(({ file, path }) => projectFileFromFile(file, path)))
            .catch(error => reportFailure('Open', error));
        controls.openFolderInput.value = '';
    });

    syncSettingsControls(host);
}

const INITIAL_TEX = 'Loading the SnapTeX demo project...';
async function loadDefaultDemoProject(host: StandaloneHost): Promise<void> {
    setStatus('Loading demo project...');
    await loadProject(host, createStandaloneDemoProjectFiles());
}

const editorParent = requireElement('editor');

const splitter = getElement('splitter');
if (splitter) {
    enableSplitPaneResize(splitter);
}

setExplorerCollapsed(true);
setDiagnosticsVisible(true);
setTheme('light');

let host: StandaloneHost;
host = createStandaloneSnapTeXApp({
    editorParent,
    initialText: INITIAL_TEX,
    settings: DEFAULT_STANDALONE_PREVIEW_SETTINGS,
    onStateChange: renderProjectState
});
bindProjectControls(host);
void loadDefaultDemoProject(host).catch(error => reportFailure('Load demo', error));
