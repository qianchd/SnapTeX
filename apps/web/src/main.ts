import { createStandaloneSnapTeXApp, DEFAULT_STANDALONE_PREVIEW_SETTINGS, type StandaloneHost, type StandalonePreviewSettings } from '../../standalone/src/app';
import {
    chooseRootPath,
    fileInputPath,
    isProjectFile,
    isTexFile,
    projectFileFromFile,
    projectFileFromHandle,
    projectTextPaths,
    readDirectoryHandle,
    type BrowserDirectoryHandle,
    type BrowserFileHandle
} from '../../standalone/src/browser-project';
import { normalizeBrowserPath, type BrowserProjectFile } from '../../standalone/src/browser-file-provider';

const RESIZE_WIDTH_STEP_PX = 10;
const RESIZE_FRAME_INTERVAL_MS = 30;

interface BrowserFilePickerWindow extends Window {
    showOpenFilePicker?: (options?: {
        multiple?: boolean;
        types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<BrowserFileHandle[]>;
    showDirectoryPicker?: () => Promise<BrowserDirectoryHandle>;
}

let currentProjectTextPaths: string[] = [];
let explorerCollapsed = false;
const expandedFolders = new Set<string>();
type WebTheme = 'light' | 'dark' | 'blue' | 'rose';
type BooleanPreviewSetting = 'livePreview' | 'autoScrollSync' | 'virtualMode' | 'debugMemory';
type NumberPreviewSetting = 'renderDelayMs' | 'autoScrollDelayMs';

interface ProjectTreeNode {
    name: string;
    path: string;
    kind: 'file' | 'folder';
    children: ProjectTreeNode[];
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
    const status = document.getElementById('project-status');
    if (status) {
        status.textContent = message;
    }
}

function reportFailure(action: string, error: unknown): void {
    setStatus(`${action} failed: ${error instanceof Error ? error.message : String(error)}`);
}

function expandFoldersFromPaths(paths: readonly string[]): void {
    for (const path of paths.map(normalizeBrowserPath)) {
        const parts = path.split('/').filter(Boolean);
        let currentPath = '';
        for (let index = 0; index < parts.length - 1; index++) {
            currentPath += `/${parts[index]}`;
            expandedFolders.add(currentPath);
        }
    }
}

async function loadProject(host: StandaloneHost, files: readonly BrowserProjectFile[]): Promise<void> {
    const rootPath = chooseRootPath(files);
    if (!rootPath) {
        setStatus('No TeX file found.');
        return;
    }

    await host.loadProject(files, rootPath);
    currentProjectTextPaths = projectTextPaths(files);
    expandedFolders.clear();
    expandFoldersFromPaths(currentProjectTextPaths);
    renderProjectState(host);
    setStatus(`Opened ${rootPath} (${files.length} files)`);
}

function renderProjectState(host: StandaloneHost): void {
    renderChromeState(host);
    renderProjectFiles(host, currentProjectTextPaths);
    renderProjectDiagnostics(host);
}

function setText(id: string, text: string): void {
    const element = document.getElementById(id);
    if (element) {
        element.textContent = text;
        element.title = text;
    }
}

function renderChromeState(host: StandaloneHost): void {
    const activePath = host.getActivePath();
    const rootPath = host.getRootPath();
    setText('active-path-label', `${activePath}${host.isDirty(activePath) ? ' *' : ''}`);
    setText('root-path-label', `root: ${rootPath}`);
    syncSettingsControls(host);

    const setRootButton = document.getElementById('set-root-button') as HTMLButtonElement | null;
    if (setRootButton) {
        const canSetRoot = isTexFile(activePath) && activePath !== rootPath;
        setRootButton.disabled = !canSetRoot;
        setRootButton.title = canSetRoot ? `Set ${activePath} as preview root` : 'Current TeX file is already the preview root';
    }
}

function createProjectTree(paths: readonly string[]): ProjectTreeNode {
    const root: ProjectTreeNode = { name: '', path: '/', kind: 'folder', children: [] };
    const folderByPath = new Map<string, ProjectTreeNode>([['/', root]]);

    for (const path of paths.map(normalizeBrowserPath)) {
        const parts = path.split('/').filter(Boolean);
        let parent = root;
        let currentPath = '';
        parts.forEach((part, index) => {
            currentPath += `/${part}`;
            const isFile = index === parts.length - 1;
            if (isFile) {
                parent.children.push({ name: part, path: currentPath, kind: 'file', children: [] });
                return;
            }

            let folder = folderByPath.get(currentPath);
            if (!folder) {
                folder = { name: part, path: currentPath, kind: 'folder', children: [] };
                folderByPath.set(currentPath, folder);
                parent.children.push(folder);
            }
            parent = folder;
        });
    }

    const sortTree = (node: ProjectTreeNode): void => {
        node.children.sort((a, b) => {
            if (a.kind !== b.kind) {
                return a.kind === 'folder' ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });
        node.children.forEach(sortTree);
    };
    sortTree(root);
    return root;
}

function renderProjectFiles(host: StandaloneHost, paths: readonly string[]): void {
    const fileList = document.getElementById('project-files');
    if (!fileList) {
        return;
    }

    fileList.replaceChildren(...createProjectTree(paths).children.flatMap(node => renderProjectTreeNode(host, node, 0)));
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
            renderProjectFiles(host, currentProjectTextPaths);
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
                renderProjectState(host);
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
    const panel = document.getElementById('project-diagnostics');
    if (!panel) {
        return;
    }

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
    renderProjectState(host);
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
        renderProjectState(host);
        return;
    }

    await host.setPreviewRoot(path);
    renderProjectState(host);
    setStatus(`Preview root ${path}`);
}

function setExplorerCollapsed(collapsed: boolean): void {
    explorerCollapsed = collapsed;
    document.body.dataset.explorerCollapsed = String(collapsed);
    const button = document.getElementById('toggle-explorer-button');
    if (button) {
        button.setAttribute('aria-expanded', String(!collapsed));
    }
    const toggle = document.getElementById('show-explorer-toggle') as HTMLInputElement | null;
    if (toggle) {
        toggle.checked = !collapsed;
    }
}

function setDiagnosticsVisible(visible: boolean): void {
    document.body.dataset.diagnosticsVisible = String(visible);
    const toggle = document.getElementById('show-diagnostics-toggle') as HTMLInputElement | null;
    if (toggle) {
        toggle.checked = visible;
    }
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
    const select = document.getElementById('theme-select') as HTMLSelectElement | null;
    if (select) {
        select.value = theme;
    }
}

function syncSettingsControls(host: StandaloneHost): void {
    const settings = host.getSettings();
    const livePreviewToggle = document.getElementById('live-preview-toggle') as HTMLInputElement | null;
    const autoScrollToggle = document.getElementById('auto-scroll-toggle') as HTMLInputElement | null;
    const virtualModeToggle = document.getElementById('virtual-mode-toggle') as HTMLInputElement | null;
    const debugMemoryToggle = document.getElementById('debug-memory-toggle') as HTMLInputElement | null;
    const renderDelayInput = document.getElementById('render-delay-input') as HTMLInputElement | null;
    const autoScrollDelayInput = document.getElementById('auto-scroll-delay-input') as HTMLInputElement | null;

    if (livePreviewToggle) { livePreviewToggle.checked = settings.livePreview; }
    if (autoScrollToggle) { autoScrollToggle.checked = settings.autoScrollSync; }
    if (virtualModeToggle) { virtualModeToggle.checked = settings.virtualMode; }
    if (debugMemoryToggle) { debugMemoryToggle.checked = settings.debugMemory; }
    if (renderDelayInput) { setInputValue(renderDelayInput, settings.renderDelayMs); }
    if (autoScrollDelayInput) { setInputValue(autoScrollDelayInput, settings.autoScrollDelayMs); }
}

function bindProjectControls(host: StandaloneHost): void {
    const toggleExplorerButton = document.getElementById('toggle-explorer-button');
    const openFileButton = document.getElementById('open-file-button');
    const openFolderButton = document.getElementById('open-folder-button');
    const saveButton = document.getElementById('save-button');
    const setRootButton = document.getElementById('set-root-button');
    const settingsButton = document.getElementById('settings-button');
    const settingsMenu = document.getElementById('settings-menu');
    const showExplorerToggle = document.getElementById('show-explorer-toggle') as HTMLInputElement | null;
    const showDiagnosticsToggle = document.getElementById('show-diagnostics-toggle') as HTMLInputElement | null;
    const livePreviewToggle = document.getElementById('live-preview-toggle') as HTMLInputElement | null;
    const autoScrollToggle = document.getElementById('auto-scroll-toggle') as HTMLInputElement | null;
    const virtualModeToggle = document.getElementById('virtual-mode-toggle') as HTMLInputElement | null;
    const debugMemoryToggle = document.getElementById('debug-memory-toggle') as HTMLInputElement | null;
    const renderDelayInput = document.getElementById('render-delay-input') as HTMLInputElement | null;
    const autoScrollDelayInput = document.getElementById('auto-scroll-delay-input') as HTMLInputElement | null;
    const themeSelect = document.getElementById('theme-select') as HTMLSelectElement | null;
    const openFileInput = document.getElementById('open-file-input') as HTMLInputElement | null;
    const openFolderInput = document.getElementById('open-folder-input') as HTMLInputElement | null;
    if (!toggleExplorerButton || !openFileButton || !openFolderButton || !saveButton || !setRootButton || !settingsButton || !settingsMenu || !showExplorerToggle || !showDiagnosticsToggle || !livePreviewToggle || !autoScrollToggle || !virtualModeToggle || !debugMemoryToggle || !renderDelayInput || !autoScrollDelayInput || !themeSelect || !openFileInput || !openFolderInput) {
        throw new Error('Missing web project controls.');
    }
    const setSettingsOpen = (open: boolean): void => {
        settingsButton.setAttribute('aria-expanded', String(open));
        settingsMenu.hidden = !open;
    };
    const bindToggleSetting = (input: HTMLInputElement, setting: BooleanPreviewSetting): void => {
        input.addEventListener('change', () => host.updateSettings({ [setting]: input.checked } as Partial<StandalonePreviewSettings>));
    };
    const bindNumberSetting = (input: HTMLInputElement, setting: NumberPreviewSetting, fallback: number): void => {
        input.addEventListener('change', () => host.updateSettings({ [setting]: readClampedNumber(input, fallback) } as Partial<StandalonePreviewSettings>));
    };

    toggleExplorerButton.addEventListener('click', () => {
        setExplorerCollapsed(!explorerCollapsed);
    });
    openFileButton.addEventListener('click', () => {
        openSingleFile(host, openFileInput).catch(error => reportFailure('Open', error));
    });
    openFolderButton.addEventListener('click', () => {
        openFolder(host, openFolderInput).catch(error => reportFailure('Open', error));
    });
    saveButton.addEventListener('click', () => {
        saveActiveFile(host).catch(error => reportFailure('Save', error));
    });
    bindSaveShortcut(host);
    setRootButton.addEventListener('click', () => {
        setActiveFileAsRoot(host).catch(error => reportFailure('Set root', error));
    });
    settingsButton.addEventListener('click', () => {
        setSettingsOpen(settingsButton.getAttribute('aria-expanded') !== 'true');
    });
    showExplorerToggle.addEventListener('change', () => {
        setExplorerCollapsed(!showExplorerToggle.checked);
    });
    showDiagnosticsToggle.addEventListener('change', () => {
        setDiagnosticsVisible(showDiagnosticsToggle.checked);
    });
    bindToggleSetting(livePreviewToggle, 'livePreview');
    bindToggleSetting(autoScrollToggle, 'autoScrollSync');
    bindToggleSetting(virtualModeToggle, 'virtualMode');
    bindToggleSetting(debugMemoryToggle, 'debugMemory');
    bindNumberSetting(renderDelayInput, 'renderDelayMs', DEFAULT_STANDALONE_PREVIEW_SETTINGS.renderDelayMs);
    bindNumberSetting(autoScrollDelayInput, 'autoScrollDelayMs', DEFAULT_STANDALONE_PREVIEW_SETTINGS.autoScrollDelayMs);
    themeSelect.addEventListener('change', () => {
        setTheme(themeSelect.value as WebTheme);
    });
    document.addEventListener('click', event => {
        const target = event.target as Node | null;
        if (target && !settingsButton.contains(target) && !settingsMenu.contains(target)) {
            setSettingsOpen(false);
        }
    });

    openFileInput.addEventListener('change', () => {
        const file = openFileInput.files?.[0];
        if (file) {
            loadProject(host, [projectFileFromFile(file, `/${file.name}`)])
                .catch(error => reportFailure('Open', error));
        }
        openFileInput.value = '';
    });
    openFolderInput.addEventListener('change', () => {
        const files = Array.from(openFolderInput.files ?? [])
            .map(file => ({ file, path: fileInputPath(file) }))
            .filter(({ path }) => isProjectFile(path));
        loadProject(host, files.map(({ file, path }) => projectFileFromFile(file, path)))
            .catch(error => reportFailure('Open', error));
        openFolderInput.value = '';
    });

    syncSettingsControls(host);
}

const INITIAL_TEX = 'Loading the SnapTeX demo project...';
const DEMO_PROJECT_FILES = [
    { path: '/demo/main.tex', url: 'demo/main.tex', text: true },
    { path: '/demo/sample.bib', url: 'demo/sample.bib', text: true },
    { path: '/demo/sections/project-editing.tex', url: 'demo/sections/project-editing.tex', text: true },
    { path: '/demo/frog.jpg', url: 'demo/frog.jpg' }
] satisfies ReadonlyArray<{ path: string; url: string; text?: boolean }>;

async function fetchText(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to load ${url}: ${response.status}`);
    }
    return response.text();
}

function demoProjectFile(file: typeof DEMO_PROJECT_FILES[number]): BrowserProjectFile {
    return file.text
        ? { path: file.path, readText: () => fetchText(file.url) }
        : { path: file.path, resourceUrl: file.url };
}

async function loadDefaultDemoProject(host: StandaloneHost): Promise<void> {
    setStatus('Loading demo project...');
    await loadProject(host, DEMO_PROJECT_FILES.map(demoProjectFile));
}

const editorParent = document.getElementById('editor');
if (!editorParent) {
    throw new Error('Missing #editor container.');
}

const splitter = document.getElementById('splitter');
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
