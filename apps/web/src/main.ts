import { createStandaloneSnapTeXApp, DEFAULT_STANDALONE_PREVIEW_SETTINGS, type StandaloneHost, type StandalonePreviewSettings } from '../../standalone/src/app';
import { createProjectZip } from '../../standalone/src/project-archive';
import type { BackendMode, PreviewLayoutMode, PreviewStyleSettings } from '../../../src/types';
import {
    createProjectTree,
    isProjectFile,
    isTexFile,
    projectFolderPaths,
    type BrowserProject,
    type ProjectTreeNode
} from '../../standalone/src/browser-project';
import { DEMO_PROJECT_ID, DEMO_PROJECT_NAME, loadDemoFiles } from './demo-project';
import { BrowserWorkspaceStore, type BrowserImportFile, type ProjectHistoryEntry } from './indexeddb-project';
import {
    createDirectoryProject,
    fileInputPath,
    type BrowserDirectoryHandle,
    type BrowserFileHandle
} from './local-project';
import {
    createRemoteProject,
    loadRemoteProject,
    RemoteProjectAuthenticationError,
    RemoteProjectNotFoundError
} from './remote-project';


interface BrowserFilePickerWindow extends Window {
    showOpenFilePicker?: (options?: {
        multiple?: boolean;
        types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<BrowserFileHandle[]>;
    showDirectoryPicker?: () => Promise<BrowserDirectoryHandle>;
}

let explorerCollapsed = false;
const expandedFolders = new Set<string>();
const browserWorkspaces = new BrowserWorkspaceStore();
let activeHistoryId: string | undefined;
type WebTheme = 'light' | 'dark' | 'blue' | 'rose';
type BooleanPreviewSetting = 'livePreview' | 'autoScrollSync' | 'virtualMode' | 'debugMemory';
type NumberPreviewSetting = 'renderDelayMs' | 'autoScrollDelayMs';
type TextPreviewSetting = keyof PreviewStyleSettings;
type BooleanSettingControl = 'livePreviewToggle' | 'autoScrollToggle' | 'virtualModeToggle' | 'debugMemoryToggle';
type NumberSettingControl = 'renderDelayInput' | 'autoScrollDelayInput';
type TextSettingControl = 'previewFontSizeInput' | 'previewLineHeightInput' | 'previewContentWidthInput' | 'previewFontFamilyInput';

const DEFAULT_WEB_PREVIEW_SETTINGS: StandalonePreviewSettings = {
    ...DEFAULT_STANDALONE_PREVIEW_SETTINGS,
    fontSize: '2.8cqw',
    contentMaxWidth: '920px'
};

const BOOLEAN_SETTING_CONTROLS: ReadonlyArray<[BooleanSettingControl, BooleanPreviewSetting]> = [
    ['livePreviewToggle', 'livePreview'],
    ['autoScrollToggle', 'autoScrollSync'],
    ['virtualModeToggle', 'virtualMode'],
    ['debugMemoryToggle', 'debugMemory']
];

const NUMBER_SETTING_CONTROLS: ReadonlyArray<[NumberSettingControl, NumberPreviewSetting, number]> = [
    ['renderDelayInput', 'renderDelayMs', DEFAULT_WEB_PREVIEW_SETTINGS.renderDelayMs],
    ['autoScrollDelayInput', 'autoScrollDelayMs', DEFAULT_WEB_PREVIEW_SETTINGS.autoScrollDelayMs]
];

const TEXT_SETTING_CONTROLS: ReadonlyArray<[TextSettingControl, TextPreviewSetting]> = [
    ['previewFontSizeInput', 'fontSize'],
    ['previewLineHeightInput', 'lineHeight'],
    ['previewContentWidthInput', 'contentMaxWidth'],
    ['previewFontFamilyInput', 'fontFamily']
];
const WEB_PREFERENCES_STORAGE_KEY = 'snaptex.previewStyle';

function loadWebPreferences() {
    const settings = { ...DEFAULT_WEB_PREVIEW_SETTINGS };
    try {
        const stored = JSON.parse(localStorage.getItem(WEB_PREFERENCES_STORAGE_KEY) || '{}') as Record<string, unknown>;
        for (const [, setting] of BOOLEAN_SETTING_CONTROLS) {
            if (typeof stored[setting] === 'boolean') {
                settings[setting] = stored[setting];
            }
        }
        for (const [, setting] of NUMBER_SETTING_CONTROLS) {
            if (typeof stored[setting] === 'number' && Number.isFinite(stored[setting])) {
                settings[setting] = stored[setting];
            }
        }
        for (const [, setting] of TEXT_SETTING_CONTROLS) {
            const value = stored[setting];
            if (typeof value === 'string' && value.trim()) {
                settings[setting] = value.trim();
            }
        }
        if (stored.backendMode === 'legacy' || stored.backendMode === 'ast(experimental)') {
            settings.backendMode = stored.backendMode;
        }
        if (stored.previewLayout === 'continuous' || stored.previewLayout === 'paged') {
            settings.previewLayout = stored.previewLayout;
        }
        const theme: WebTheme = stored.theme === 'dark' || stored.theme === 'blue' || stored.theme === 'rose'
            ? stored.theme
            : 'light';
        return {
            settings,
            theme,
            explorerCollapsed: stored.explorerCollapsed !== false,
            diagnosticsVisible: stored.diagnosticsVisible !== false
        };
    } catch {
        return { settings, theme: 'light' as WebTheme, explorerCollapsed: true, diagnosticsVisible: true };
    }
}

function storeWebPreferences(host: StandaloneHost): void {
    try {
        localStorage.setItem(WEB_PREFERENCES_STORAGE_KEY, JSON.stringify({
            ...host.getSettings(),
            theme: document.body.dataset.theme,
            explorerCollapsed,
            diagnosticsVisible: document.body.dataset.diagnosticsVisible === 'true'
        }));
    } catch {
        // Preview settings remain available for this page when storage is unavailable.
    }
}

const webPreferences = loadWebPreferences();

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
        status: requireElement('project-status'),
        projectFiles: requireElement('project-files'),
        projectDiagnostics: requireElement('project-diagnostics'),
        toggleExplorerButton: requireElement('toggle-explorer-button'),
        openFileButton: requireElement('open-file-button'),
        openFolderButton: requireElement('open-folder-button'),
        importFolderButton: requireElement('import-folder-button'),
        openWorkspaceButton: requireElement('open-workspace-button'),
        openRemoteButton: requireElement('open-remote-button'),
        newFileButton: requireElement<HTMLButtonElement>('new-file-button'),
        deleteFileButton: requireElement<HTMLButtonElement>('delete-file-button'),
        exportButton: requireElement<HTMLButtonElement>('export-button'),
        saveButton: requireElement<HTMLButtonElement>('save-button'),
        setRootButton: requireElement<HTMLButtonElement>('set-root-button'),
        logoutButton: requireElement<HTMLButtonElement>('logout-button'),
        showExplorerToggle: requireElement<HTMLInputElement>('show-explorer-toggle'),
        showDiagnosticsToggle: requireElement<HTMLInputElement>('show-diagnostics-toggle'),
        livePreviewToggle: requireElement<HTMLInputElement>('live-preview-toggle'),
        autoScrollToggle: requireElement<HTMLInputElement>('auto-scroll-toggle'),
        virtualModeToggle: requireElement<HTMLInputElement>('virtual-mode-toggle'),
        debugMemoryToggle: requireElement<HTMLInputElement>('debug-memory-toggle'),
        backendModeSelect: requireElement<HTMLSelectElement>('backend-mode-select'),
        previewLayoutSelect: requireElement<HTMLSelectElement>('preview-layout-select'),
        renderDelayInput: requireElement<HTMLInputElement>('render-delay-input'),
        autoScrollDelayInput: requireElement<HTMLInputElement>('auto-scroll-delay-input'),
        previewFontSizeInput: requireElement<HTMLInputElement>('preview-font-size-input'),
        previewLineHeightInput: requireElement<HTMLInputElement>('preview-line-height-input'),
        previewContentWidthInput: requireElement<HTMLInputElement>('preview-content-width-input'),
        previewFontFamilyInput: requireElement<HTMLInputElement>('preview-font-family-input'),
        themeSelect: requireElement<HTMLSelectElement>('theme-select'),
        welcomePage: requireElement('welcome-page'),
        welcomeOpenFolderButton: requireElement('welcome-open-folder-button'),
        welcomeImportFolderButton: requireElement('welcome-import-folder-button'),
        welcomeOpenDemoButton: requireElement('welcome-open-demo-button'),
        welcomeOpenWorkspaceButton: requireElement('welcome-open-workspace-button'),
        welcomeOpenRemoteButton: requireElement('welcome-open-remote-button'),
        remoteProjectDialog: requireElement<HTMLDialogElement>('remote-project-dialog'),
        remoteProjectForm: requireElement<HTMLFormElement>('remote-project-form'),
        remoteProjectName: requireElement<HTMLInputElement>('remote-project-name'),
        remoteProjectCancelButton: requireElement<HTMLButtonElement>('remote-project-cancel-button'),
        remoteProjectConnectButton: requireElement<HTMLButtonElement>('remote-project-connect-button'),
        remoteProjectError: requireElement('remote-project-error'),
        newFileDialog: requireElement<HTMLDialogElement>('new-file-dialog'),
        newFileForm: requireElement<HTMLFormElement>('new-file-form'),
        newFilePath: requireElement<HTMLInputElement>('new-file-path'),
        newFileCancelButton: requireElement<HTMLButtonElement>('new-file-cancel-button'),
        newFileError: requireElement('new-file-error'),
        openFileInput: requireElement<HTMLInputElement>('open-file-input'),
        openFolderInput: requireElement<HTMLInputElement>('open-folder-input'),
        workspaceDialog: requireElement<HTMLDialogElement>('workspace-dialog'),
        workspaceList: requireElement('workspace-list'),
        workspaceCancelButton: requireElement<HTMLButtonElement>('workspace-cancel-button')
    };
}

const webControls = readControls();

function enableSplitPaneResize(splitter: HTMLElement): void {
    const shell = document.getElementById('workspace');
    const editorPane = document.getElementById('editor-pane');
    const restoreButton = getElement<HTMLButtonElement>('restore-pane-button');
    if (!shell || !editorPane || !restoreButton) {
        return;
    }

    type PaneLayout = 'split' | 'editor' | 'preview';
    interface InteractivePreviewController {
        beginInteractiveResize(): void;
        finishInteractiveResize(update: () => void): void;
    }
    const getPreviewController = (): InteractivePreviewController | undefined =>
        (window as Window & { snaptexPreviewController?: InteractivePreviewController }).snaptexPreviewController;
    const portraitLayout = window.matchMedia('(max-width: 820px) and (orientation: portrait)');
    const mobilePaneButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-mobile-pane]'));
    let paneLayout: PaneLayout = 'split';
    let mobilePaneLayout: Exclude<PaneLayout, 'split'> = 'editor';
    let previewScrollTop = 0;
    let lastSplitEditorWidth: number | undefined;
    let dragState: {
        editorLeft: number;
        availableWidth: number;
        minEditorWidth: number;
        minPreviewWidth: number;
        splitterWidth: number;
        collapseDistance: number;
        nextWidth: number;
        animationFrame: number | undefined;
    } | undefined;

    const cssNumber = (name: string): number => {
        const value = Number.parseFloat(getComputedStyle(shell).getPropertyValue(name));
        return Number.isFinite(value) ? value : 0;
    };

    const clampedEditorWidth = (clientX: number, state: NonNullable<typeof dragState>): number =>
        Math.round(Math.min(
            state.availableWidth - state.collapseDistance - state.splitterWidth,
            Math.max(state.collapseDistance, clientX - state.editorLeft)
        ));

    const setPaneLayout = (layout: PaneLayout, notify = true): void => {
        if (portraitLayout.matches && paneLayout === 'preview' && layout !== 'preview') {
            previewScrollTop = window.scrollY;
        }
        paneLayout = layout;
        if (layout !== 'split') {
            mobilePaneLayout = layout;
        }
        document.body.dataset.paneLayout = layout;
        window.snaptexStandaloneHost?.setPaneVisibility(layout !== 'preview', layout !== 'editor');
        restoreButton.hidden = layout === 'split';
        for (const button of mobilePaneButtons) {
            button.setAttribute('aria-pressed', String(button.dataset.mobilePane === layout));
        }
        if (layout !== 'split') {
            const showingEditor = layout === 'editor';
            restoreButton.dataset.direction = showingEditor ? 'left' : 'right';
            restoreButton.title = showingEditor ? 'Show preview panel' : 'Show editor panel';
            restoreButton.setAttribute('aria-label', restoreButton.title);
        }
        if (notify) {
            window.requestAnimationFrame(() => {
                if (portraitLayout.matches && layout === 'preview') {
                    window.scrollTo(0, previewScrollTop);
                }
                window.dispatchEvent(new Event('resize'));
            });
        }
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
            dragState.animationFrame = undefined;
            document.body.style.setProperty(
                '--snaptex-web-resize-indicator-left',
                `${dragState.editorLeft + dragState.nextWidth}px`
            );
        });
    };

    const startResize = (event: PointerEvent): void => {
        if (paneLayout !== 'split' || event.target === restoreButton) {
            return;
        }
        const shellRect = shell.getBoundingClientRect();
        const editorRect = editorPane.getBoundingClientRect();
        const availableWidth = shellRect.right - editorRect.left;
        const minEditorWidth = cssNumber('--snaptex-web-min-editor-width');
        const minPreviewWidth = cssNumber('--snaptex-web-min-preview-width');
        const splitterWidth = cssNumber('--snaptex-web-splitter-width');
        lastSplitEditorWidth = Math.round(editorRect.width);
        dragState = {
            editorLeft: editorRect.left,
            availableWidth,
            minEditorWidth,
            minPreviewWidth,
            splitterWidth,
            collapseDistance: cssNumber('--snaptex-web-collapse-distance'),
            nextWidth: Math.round(editorRect.width),
            animationFrame: undefined
        };
        document.body.classList.add('is-resizing-split');
        document.body.style.setProperty('--snaptex-web-resize-indicator-left', `${editorRect.right}px`);
        getPreviewController()?.beginInteractiveResize();

        splitter.setPointerCapture(event.pointerId);
        scheduleEditorWidth(event.clientX);
        event.preventDefault();
    };

    const endResize = (event: PointerEvent): void => {
        const state = dragState;
        let nextLayout: PaneLayout = 'split';
        let nextEditorWidth: number | undefined;
        if (state?.animationFrame !== undefined) {
            window.cancelAnimationFrame(state.animationFrame);
        }
        if (state && event.type !== 'pointercancel') {
            const rawEditorWidth = event.clientX - state.editorLeft;
            state.nextWidth = clampedEditorWidth(event.clientX, state);
            const rawPreviewWidth = state.availableWidth - rawEditorWidth - state.splitterWidth;
            if (rawEditorWidth <= state.collapseDistance) {
                nextLayout = 'preview';
            } else if (rawPreviewWidth <= state.collapseDistance) {
                nextLayout = 'editor';
            } else {
                nextEditorWidth = Math.min(
                    state.availableWidth - state.minPreviewWidth - state.splitterWidth,
                    Math.max(state.minEditorWidth, state.nextWidth)
                );
            }
        }
        dragState = undefined;
        window.requestAnimationFrame(() => {
            const finish = (): void => {
                document.body.classList.remove('is-resizing-split');
                document.body.style.removeProperty('--snaptex-web-resize-indicator-left');
                if (nextLayout === 'split' && nextEditorWidth !== undefined) {
                    shell.style.setProperty('--snaptex-web-editor-width', `${nextEditorWidth}px`);
                    lastSplitEditorWidth = nextEditorWidth;
                } else if (nextLayout !== 'split') {
                    setPaneLayout(nextLayout, false);
                }
                window.dispatchEvent(new Event('resize'));
            };
            const previewController = getPreviewController();
            if (previewController) {previewController.finishInteractiveResize(finish);}
            else {finish();}
        });
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
    restoreButton.addEventListener('pointerdown', event => event.stopPropagation());
    restoreButton.addEventListener('click', () => {
        if (lastSplitEditorWidth !== undefined) {
            shell.style.setProperty('--snaptex-web-editor-width', `${lastSplitEditorWidth}px`);
        }
        setPaneLayout('split');
    });
    for (const button of mobilePaneButtons) {
        button.addEventListener('click', () => {
            const layout = button.dataset.mobilePane;
            if (layout === 'editor' || layout === 'preview') {
                setPaneLayout(layout);
            }
        });
    }
    document.addEventListener('keydown', event => {
        if (portraitLayout.matches
            && paneLayout === 'editor'
            && (event.ctrlKey || event.metaKey)
            && event.altKey
            && !event.shiftKey
            && event.key.toLowerCase() === 'm') {
            window.requestAnimationFrame(() => setPaneLayout('preview'));
        }
    }, { capture: true });
    document.addEventListener('dblclick', event => {
        if (portraitLayout.matches
            && paneLayout === 'preview'
            && event.target instanceof Element
            && event.target.closest('#preview-pane .latex-block')) {
            setPaneLayout('editor');
        }
    });
    const applyResponsiveLayout = (): void => {
        setPaneLayout(portraitLayout.matches ? mobilePaneLayout : 'split');
    };
    portraitLayout.addEventListener('change', applyResponsiveLayout);
    applyResponsiveLayout();
}

function setStatus(message: string): void {
    webControls.status.textContent = message;
}

function reportFailure(action: string, error: unknown): void {
    setStatus(`${action} failed: ${error instanceof Error ? error.message : String(error)}`);
}

async function loadProject(host: StandaloneHost, project: BrowserProject, historyId = project.id): Promise<void> {
    const rootPath = await host.loadProject(project);
    activeHistoryId = historyId;

    expandedFolders.clear();
    projectFolderPaths(host.getProjectTextPaths()).forEach(path => expandedFolders.add(path));
    renderProjectState(host);
    setStatus(`Opened ${rootPath} (${project.files.length} files)`);
}

function renderProjectState(host: StandaloneHost): void {
    const projectOpen = host.getProjectTextPaths().length > 0;
    document.body.dataset.projectOpen = String(projectOpen);
    webControls.welcomePage.hidden = projectOpen;
    renderChromeState(host, projectOpen);
    renderProjectFiles(host);
    renderProjectDiagnostics(host);
}

function renderChromeState(host: StandaloneHost, projectOpen: boolean): void {
    const controls = webControls;
    const activePath = host.getActivePath();
    const rootPath = host.getRootPath();
    const activePathText = projectOpen ? `${activePath}${host.isDirty(activePath) ? ' *' : ''}` : 'No project open';
    controls.activePathLabel.textContent = activePathText;
    controls.activePathLabel.title = activePathText;
    controls.saveButton.disabled = !projectOpen;
    controls.exportButton.disabled = !projectOpen;
    controls.newFileButton.disabled = !projectOpen || !host.canModifyProject();
    controls.deleteFileButton.disabled = !projectOpen || !host.canModifyProject() || activePath === rootPath;
    syncSettingsControls(host);

    const canSetRoot = projectOpen && isTexFile(activePath) && activePath !== rootPath;
    controls.setRootButton.disabled = !canSetRoot;
    controls.setRootButton.title = canSetRoot ? `Set ${activePath} as preview root` : 'Current TeX file is already the preview root';
}

function renderProjectFiles(host: StandaloneHost): void {
    const rows = createProjectTree(host.getProjectTextPaths())
        .children
        .flatMap(node => renderProjectTreeNode(host, node, 0));
    webControls.projectFiles.replaceChildren(...rows);
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
    const panel = webControls.projectDiagnostics;
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
    reimportWorkspaceId = undefined;
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
            await importBrowserFiles(host, [{ path: `/${handle.name}`, file: await handle.getFile() }], handle.name);
        }
        return;
    }

    input.click();
}

async function openFolder(host: StandaloneHost, input: HTMLInputElement): Promise<void> {
    reimportWorkspaceId = undefined;
    const pickerWindow = window as BrowserFilePickerWindow;
    if (pickerWindow.showDirectoryPicker) {
        const directory = await pickerWindow.showDirectoryPicker();
        const project = await createDirectoryProject(directory);
        const historyId = await browserWorkspaces.rememberDirectory(directory).catch(() => undefined);
        await loadProject(host, project, historyId);
        return;
    }

    input.click();
}

async function importBrowserFiles(host: StandaloneHost, files: BrowserImportFile[], name: string): Promise<void> {
    if (reimportWorkspaceId) {
        const projectId = reimportWorkspaceId;
        reimportWorkspaceId = undefined;
        const conflicts = await browserWorkspaces.reimportFiles(projectId, files);
        if (conflicts.length > 0) {
            const paths = conflicts.join(', ');
            if (!window.confirm(`These files changed both locally and in the imported folder: ${paths}\n\nOverwrite the local edits with the imported files?`)) {
                setStatus('Re-import stopped: local changes were kept.');
                return;
            }
            await browserWorkspaces.reimportFiles(projectId, files, true);
        }
        await loadProject(host, await browserWorkspaces.open(projectId));
        return;
    }
    const summary = await browserWorkspaces.importFiles(name, files);
    await loadProject(host, await browserWorkspaces.open(summary.id));
}

let remoteProjectToCreate: string | undefined;
let reimportWorkspaceId: string | undefined;

function fetchWebSession(): Promise<Response> {
    return fetch(new URL('web-auth/session', document.baseURI), { credentials: 'same-origin' });
}

function supportsRemoteProjects(): boolean {
    return document.body.dataset.deploymentMode === 'server';
}

function redirectToServerLogin(): void {
    const loginUrl = new URL('web-auth/login', document.baseURI);
    loginUrl.searchParams.set('return_to', `${window.location.pathname}${window.location.search}`);
    window.location.assign(loginUrl);
}

async function openRemoteProjectDialog(): Promise<void> {
    const controls = webControls;
    if (!supportsRemoteProjects()) {
        controls.remoteProjectDialog.showModal();
        return;
    }
    try {
        if ((await fetchWebSession()).status === 401) {
            redirectToServerLogin();
            return;
        }
    } catch {
        // Let the project request surface server connectivity errors.
    }
    remoteProjectToCreate = undefined;
    controls.remoteProjectError.textContent = '';
    controls.remoteProjectConnectButton.textContent = 'Connect';
    controls.remoteProjectDialog.showModal();
    controls.remoteProjectName.select();
}

async function connectRemoteProject(host: StandaloneHost): Promise<void> {
    if (!supportsRemoteProjects()) {
        return;
    }
    const controls = webControls;
    controls.remoteProjectConnectButton.disabled = true;
    controls.remoteProjectError.textContent = '';
    setStatus('Connecting to project server...');
    try {
        const projectName = controls.remoteProjectName.value.trim();
        const apiUrl = new URL('api/projects/', document.baseURI).toString();
        const project = remoteProjectToCreate === projectName
            ? await createRemoteProject(projectName, apiUrl)
            : await loadRemoteProject(projectName, apiUrl);
        const historyId = await browserWorkspaces.rememberRemote(projectName).catch(() => undefined);
        await loadProject(host, project, historyId);
        controls.remoteProjectDialog.close();
    } catch (error) {
        if (error instanceof RemoteProjectAuthenticationError) {
            redirectToServerLogin();
            return;
        }
        if (error instanceof RemoteProjectNotFoundError) {
            remoteProjectToCreate = controls.remoteProjectName.value.trim();
            controls.remoteProjectError.textContent = 'Project does not exist. Create it?';
            controls.remoteProjectConnectButton.textContent = 'Create project';
            setStatus('Project does not exist.');
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        controls.remoteProjectError.textContent = message;
        setStatus(`Connect failed: ${message}`);
    } finally {
        controls.remoteProjectConnectButton.disabled = false;
    }
}

function openNewFileDialog(): void {
    const controls = webControls;
    controls.newFileError.textContent = '';
    controls.newFilePath.value = '';
    controls.newFileDialog.showModal();
    controls.newFilePath.focus();
}

async function createTextFile(host: StandaloneHost): Promise<void> {
    const controls = webControls;
    try {
        await host.createTextFile(controls.newFilePath.value.trim());
        controls.newFileDialog.close();
        setStatus(`Created ${host.getActivePath()}`);
    } catch (error) {
        controls.newFileError.textContent = error instanceof Error ? error.message : String(error);
    }
}

async function deleteActiveFile(host: StandaloneHost): Promise<void> {
    const path = host.getActivePath();
    if (!window.confirm(`Delete ${path}?`)) {
        return;
    }
    await host.deleteTextFile(path);
    setStatus(`Deleted ${path}`);
}

function downloadBlob(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url));
}

async function exportProject(host: StandaloneHost): Promise<void> {
    const snapshot = await host.createProjectSnapshot();
    const blob = await createProjectZip(snapshot);
    downloadBlob(blob, `${snapshot.name.replace(/[^A-Za-z0-9._-]+/g, '-') || 'snaptex-project'}.zip`);
    setStatus(`Exported ${snapshot.files.length} files`);
}

function browserImportName(files: readonly File[], fallback: string): string {
    const relativePath = files[0] && (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
    return relativePath?.split('/')[0] || fallback;
}

async function openHistoryProject(host: StandaloneHost, entry: ProjectHistoryEntry): Promise<void> {
    if (entry.kind === 'workspace') {
        await loadProject(host, await browserWorkspaces.open(entry.id), entry.id);
        return;
    }
    if (entry.kind === 'directory') {
        const directory = await browserWorkspaces.directory(entry.id);
        await loadProject(host, await createDirectoryProject(directory), entry.id);
        return;
    }
    if (!supportsRemoteProjects()) {
        throw new Error('Server project history is only available from a SnapTeX Server deployment.');
    }
    const projectName = await browserWorkspaces.remoteProjectName(entry.id);
    const apiUrl = new URL('api/projects/', document.baseURI).toString();
    await loadProject(host, await loadRemoteProject(projectName, apiUrl), entry.id);
}

async function openProjectHistoryDialog(host: StandaloneHost): Promise<void> {
    const controls = webControls;
    const summaries = await browserWorkspaces.listHistory();
    if (summaries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'workspace-list-empty';
        empty.textContent = 'No project history yet.';
        controls.workspaceList.replaceChildren(empty);
    } else {
        controls.workspaceList.replaceChildren(...summaries.map(summary => {
            const row = document.createElement('div');
            row.className = 'workspace-list-row';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'workspace-list-item';
            button.textContent = `${summary.name} (${summary.detail})`;
            button.title = summary.detail;
            button.addEventListener('click', () => {
                void openHistoryProject(host, summary)
                    .then(() => controls.workspaceDialog.close())
                    .catch(error => {
                        if (error instanceof RemoteProjectAuthenticationError) {
                            redirectToServerLogin();
                        } else {
                            reportFailure('Open project', error);
                        }
                    });
            });
            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'workspace-delete-button';
            deleteButton.textContent = summary.kind === 'workspace' ? 'Delete' : 'Forget';
            deleteButton.disabled = summary.kind === 'workspace' && summary.id === activeHistoryId;
            if (deleteButton.disabled) {
                deleteButton.title = 'Open another project before deleting this workspace.';
            }
            deleteButton.addEventListener('click', () => {
                const action = summary.kind === 'workspace' ? 'Delete browser workspace' : 'Forget project';
                if (!window.confirm(`${action} "${summary.name}"?`)) {
                    return;
                }
                const remove = summary.kind === 'workspace'
                    ? browserWorkspaces.delete(summary.id)
                    : browserWorkspaces.forgetHistory(summary.id);
                void remove
                    .then(() => row.remove())
                    .catch(error => reportFailure(action, error));
            });
            row.append(button);
            if (summary.kind === 'workspace') {
                const reimportButton = document.createElement('button');
                reimportButton.type = 'button';
                reimportButton.className = 'workspace-reimport-button';
                reimportButton.textContent = 'Re-import';
                reimportButton.addEventListener('click', () => {
                    reimportWorkspaceId = summary.id;
                    controls.workspaceDialog.close();
                    controls.openFolderInput.click();
                });
                row.append(reimportButton);
            }
            row.append(deleteButton);
            return row;
        }));
    }
    controls.workspaceDialog.showModal();
}

function openImportFolder(input: HTMLInputElement): void {
    reimportWorkspaceId = undefined;
    input.click();
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

    downloadBlob(new Blob([result.text], { type: 'text/x-tex;charset=utf-8' }), result.path.split('/').pop() || 'main.tex');
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
    const controls = webControls;
    controls.toggleExplorerButton.setAttribute('aria-expanded', String(!collapsed));
    controls.showExplorerToggle.checked = !collapsed;
}

function setDiagnosticsVisible(visible: boolean): void {
    document.body.dataset.diagnosticsVisible = String(visible);
    webControls.showDiagnosticsToggle.checked = visible;
}

function setInputValue(input: HTMLInputElement, value: string | number): void {
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
    webControls.themeSelect.value = theme;
}

function syncSettingsControls(host: StandaloneHost): void {
    const settings = host.getSettings();
    const controls = webControls;
    for (const [controlName, setting] of BOOLEAN_SETTING_CONTROLS) {
        controls[controlName].checked = settings[setting];
    }
    controls.backendModeSelect.value = settings.backendMode;
    controls.previewLayoutSelect.value = settings.previewLayout;
    for (const [controlName, setting] of NUMBER_SETTING_CONTROLS) {
        setInputValue(controls[controlName], settings[setting]);
    }
    for (const [controlName, setting] of TEXT_SETTING_CONTROLS) {
        setInputValue(controls[controlName], settings[setting]);
    }
}

function bindProjectControls(host: StandaloneHost): void {
    const controls = webControls;
    const supportsLocalFolderAccess = typeof (window as BrowserFilePickerWindow).showDirectoryPicker === 'function';
    controls.openFolderButton.hidden = !supportsLocalFolderAccess;
    controls.welcomeOpenFolderButton.hidden = !supportsLocalFolderAccess;
    const toolbarMenus = Array.from(document.querySelectorAll<HTMLDetailsElement>('.toolbar-menu'));
    const closeToolbarMenus = (except?: HTMLDetailsElement): void => {
        for (const menu of toolbarMenus) {
            if (menu !== except) {
                menu.open = false;
            }
        }
    };
    const bindToggleSetting = (input: HTMLInputElement, setting: BooleanPreviewSetting): void => {
        input.addEventListener('change', () => {
            host.updateSettings({ [setting]: input.checked } as Partial<StandalonePreviewSettings>);
            storeWebPreferences(host);
        });
    };
    const bindNumberSetting = (input: HTMLInputElement, setting: NumberPreviewSetting, fallback: number): void => {
        input.addEventListener('change', () => {
            host.updateSettings({ [setting]: readClampedNumber(input, fallback) } as Partial<StandalonePreviewSettings>);
            storeWebPreferences(host);
        });
    };
    const bindTextSetting = (input: HTMLInputElement, setting: TextPreviewSetting): void => {
        input.addEventListener('change', () => {
            const value = input.value.trim() || DEFAULT_WEB_PREVIEW_SETTINGS[setting];
            input.value = value;
            host.updateSettings({ [setting]: value } as Partial<StandalonePreviewSettings>);
            storeWebPreferences(host);
        });
    };
    const openFolderProject = () => openFolder(host, controls.openFolderInput).catch(error => reportFailure('Open', error));
    const openWorkspace = () => openProjectHistoryDialog(host).catch(error => reportFailure('Open history', error));
    const openRemoteProject = () => { void openRemoteProjectDialog(); };

    controls.toggleExplorerButton.addEventListener('click', () => {
        setExplorerCollapsed(!explorerCollapsed);
        storeWebPreferences(host);
    });
    controls.openFileButton.addEventListener('click', () => {
        openSingleFile(host, controls.openFileInput).catch(error => reportFailure('Open', error));
    });
    [controls.openFolderButton, controls.welcomeOpenFolderButton]
        .forEach(button => button.addEventListener('click', openFolderProject));
    [controls.importFolderButton, controls.welcomeImportFolderButton]
        .forEach(button => button.addEventListener('click', () => openImportFolder(controls.openFolderInput)));
    [controls.openWorkspaceButton, controls.welcomeOpenWorkspaceButton]
        .forEach(button => button.addEventListener('click', openWorkspace));
    [controls.openRemoteButton, controls.welcomeOpenRemoteButton]
        .forEach(button => button.addEventListener('click', openRemoteProject));
    controls.welcomeOpenDemoButton.addEventListener('click', () => {
        loadDefaultDemoProject(host).catch(error => reportFailure('Load demo', error));
    });
    controls.remoteProjectForm.addEventListener('submit', event => {
        event.preventDefault();
        void connectRemoteProject(host);
    });
    controls.remoteProjectName.addEventListener('input', () => {
        remoteProjectToCreate = undefined;
        controls.remoteProjectError.textContent = '';
        controls.remoteProjectConnectButton.textContent = 'Connect';
    });
    controls.remoteProjectCancelButton.addEventListener('click', () => controls.remoteProjectDialog.close());
    controls.newFileButton.addEventListener('click', openNewFileDialog);
    controls.newFileForm.addEventListener('submit', event => {
        event.preventDefault();
        void createTextFile(host);
    });
    controls.newFileCancelButton.addEventListener('click', () => controls.newFileDialog.close());
    controls.workspaceCancelButton.addEventListener('click', () => controls.workspaceDialog.close());
    controls.deleteFileButton.addEventListener('click', () => {
        deleteActiveFile(host).catch(error => reportFailure('Delete', error));
    });
    controls.saveButton.addEventListener('click', () => {
        saveActiveFile(host).catch(error => reportFailure('Save', error));
    });
    controls.exportButton.addEventListener('click', () => {
        exportProject(host).catch(error => reportFailure('Export', error));
    });
    bindSaveShortcut(host);
    controls.setRootButton.addEventListener('click', () => {
        setActiveFileAsRoot(host).catch(error => reportFailure('Set root', error));
    });
    controls.showExplorerToggle.addEventListener('change', () => {
        setExplorerCollapsed(!controls.showExplorerToggle.checked);
        storeWebPreferences(host);
    });
    controls.showDiagnosticsToggle.addEventListener('change', () => {
        setDiagnosticsVisible(controls.showDiagnosticsToggle.checked);
        storeWebPreferences(host);
    });
    for (const [controlName, setting] of BOOLEAN_SETTING_CONTROLS) {
        bindToggleSetting(controls[controlName], setting);
    }
    controls.backendModeSelect.addEventListener('change', () => {
        host.updateSettings({ backendMode: controls.backendModeSelect.value as BackendMode });
        storeWebPreferences(host);
    });
    controls.previewLayoutSelect.addEventListener('change', () => {
        host.updateSettings({ previewLayout: controls.previewLayoutSelect.value as PreviewLayoutMode });
        storeWebPreferences(host);
    });
    for (const [controlName, setting, fallback] of NUMBER_SETTING_CONTROLS) {
        bindNumberSetting(controls[controlName], setting, fallback);
    }
    for (const [controlName, setting] of TEXT_SETTING_CONTROLS) {
        bindTextSetting(controls[controlName], setting);
    }
    controls.themeSelect.addEventListener('change', () => {
        setTheme(controls.themeSelect.value as WebTheme);
        storeWebPreferences(host);
    });
    for (const menu of toolbarMenus) {
        menu.addEventListener('toggle', () => {
            if (menu.open) {
                closeToolbarMenus(menu);
            }
        });
        menu.addEventListener('mouseleave', () => { menu.open = false; });
    }
    document.addEventListener('click', event => {
        const target = event.target as Node | null;
        if (target && !toolbarMenus.some(menu => menu.contains(target))) {
            closeToolbarMenus();
        }
    });

    controls.openFileInput.addEventListener('change', () => {
        const file = controls.openFileInput.files?.[0];
        if (file) {
            importBrowserFiles(host, [{ path: `/${file.name}`, file }], file.name)
                .catch(error => reportFailure('Open', error));
        }
        controls.openFileInput.value = '';
    });
    controls.openFolderInput.addEventListener('change', () => {
        const files = Array.from(controls.openFolderInput.files ?? [])
            .map(file => ({ file, path: fileInputPath(file) }))
            .filter(({ path }) => isProjectFile(path));
        if (files.length > 0) {
            importBrowserFiles(host, files, browserImportName(files.map(file => file.file), 'Imported Project'))
                .catch(error => reportFailure('Import', error));
        } else {
            reimportWorkspaceId = undefined;
        }
        controls.openFolderInput.value = '';
    });

    syncSettingsControls(host);
}

async function bindLogoutControl(): Promise<void> {
    const button = webControls.logoutButton;
    try {
        const response = await fetchWebSession();
        if (!response.ok) {
            return;
        }
        const session = await response.json() as { csrfToken?: unknown };
        if (typeof session.csrfToken !== 'string' || !session.csrfToken) {
            return;
        }
        const csrfToken = session.csrfToken;

        button.hidden = false;
        button.addEventListener('click', async () => {
            button.disabled = true;
            const logout = await fetch(new URL('web-auth/logout', document.baseURI), {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'X-CSRF-Token': csrfToken }
            });
            if (!logout.ok) {
                button.disabled = false;
                reportFailure('Log out', new Error(`Request failed: ${logout.status}`));
                return;
            }
            window.location.reload();
        });
    } catch {
        // Static deployments have no session endpoint.
    }
}

async function loadDefaultDemoProject(host: StandaloneHost): Promise<void> {
    setStatus('Loading demo project...');
    const existing = (await browserWorkspaces.list()).find(project => project.templateId === DEMO_PROJECT_ID);
    if (existing) {
        await loadProject(host, await browserWorkspaces.open(existing.id));
        return;
    }
    const summary = await browserWorkspaces.importFiles(DEMO_PROJECT_NAME, await loadDemoFiles(), DEMO_PROJECT_ID);
    await loadProject(host, await browserWorkspaces.open(summary.id));
}

const editorParent = requireElement('editor');

setExplorerCollapsed(webPreferences.explorerCollapsed);
setDiagnosticsVisible(webPreferences.diagnosticsVisible);
setTheme(webPreferences.theme);

let host: StandaloneHost;
host = createStandaloneSnapTeXApp({
    editorParent,
    initialText: '',
    settings: webPreferences.settings,
    onStateChange: renderProjectState
});
const splitter = getElement('splitter');
if (splitter) {
    enableSplitPaneResize(splitter);
}
bindProjectControls(host);
if (supportsRemoteProjects()) {
    void bindLogoutControl();
}
window.addEventListener('pagehide', () => { void host.flushProjectWrites(); });
renderProjectState(host);
