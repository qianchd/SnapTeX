import { createStandaloneSnapTeXApp, DEFAULT_STANDALONE_PREVIEW_SETTINGS, type StandaloneHost, type StandalonePreviewSettings } from '../../standalone/src/app';
import { createProjectZip } from '../../standalone/src/project-archive';
import type { BackendMode } from '../../../src/types';
import {
    createProjectTree,
    isProjectFile,
    isTexFile,
    projectFolderPaths,
    type BrowserProject,
    type ProjectTreeNode
} from '../../standalone/src/browser-project';
import { DEMO_PROJECT_ID, DEMO_PROJECT_NAME, loadDemoFiles } from './demo-project';
import { BrowserWorkspaceStore, type BrowserImportFile } from './indexeddb-project';
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
const browserWorkspaces = new BrowserWorkspaceStore();
let startupRestoreActive = true;
let activeBrowserWorkspaceId: string | undefined;
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
        settingsButton: requireElement('settings-button'),
        logoutButton: requireElement<HTMLButtonElement>('logout-button'),
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

let controls: ReturnType<typeof readControls> | undefined;

function getControls(): ReturnType<typeof readControls> {
    controls ??= readControls();
    return controls;
}

function enableSplitPaneResize(splitter: HTMLElement): void {
    const shell = document.getElementById('workspace');
    const editorPane = document.getElementById('editor-pane');
    const contentRoot = document.getElementById('content-root');
    const restoreButton = getElement<HTMLButtonElement>('restore-pane-button');
    if (!shell || !editorPane || !restoreButton) {
        return;
    }

    type PaneLayout = 'split' | 'editor' | 'preview';
    let paneLayout: PaneLayout = 'split';
    let lastSplitEditorWidth: number | undefined;
    let dragState: {
        editorLeft: number;
        maxWidth: number;
        availableWidth: number;
        rawEditorWidth: number;
        minEditorWidth: number;
        minPreviewWidth: number;
        splitterWidth: number;
        collapseDistance: number;
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

    const setPaneLayout = (layout: PaneLayout): void => {
        paneLayout = layout;
        document.body.dataset.paneLayout = layout;
        restoreButton.hidden = layout === 'split';
        if (layout !== 'split') {
            const showingEditor = layout === 'editor';
            restoreButton.dataset.direction = showingEditor ? 'left' : 'right';
            restoreButton.title = showingEditor ? 'Show preview panel' : 'Show editor panel';
            restoreButton.setAttribute('aria-label', restoreButton.title);
        }
        window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    };

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

        dragState.rawEditorWidth = clientX - dragState.editorLeft;
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
            maxWidth: Math.max(minEditorWidth, availableWidth - minPreviewWidth - splitterWidth),
            availableWidth,
            rawEditorWidth: editorRect.width,
            minEditorWidth,
            minPreviewWidth,
            splitterWidth,
            collapseDistance: cssNumber('--snaptex-web-collapse-distance'),
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
        const state = dragState;
        if (state?.animationFrame !== undefined) {
            window.cancelAnimationFrame(state.animationFrame);
        }
        if (state) {
            const rawPreviewWidth = state.availableWidth - state.rawEditorWidth - state.splitterWidth;
            if (state.rawEditorWidth < state.collapseDistance) {
                setPaneLayout('preview');
            } else if (rawPreviewWidth < state.collapseDistance) {
                setPaneLayout('editor');
            } else {
                applyEditorWidth(state, state.nextWidth);
                lastSplitEditorWidth = state.nextWidth;
            }
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
    restoreButton.addEventListener('pointerdown', event => event.stopPropagation());
    restoreButton.addEventListener('click', () => {
        if (lastSplitEditorWidth !== undefined) {
            shell.style.setProperty('--snaptex-web-editor-width', `${lastSplitEditorWidth}px`);
        }
        setPaneLayout('split');
    });
}

function setStatus(message: string): void {
    getControls().status.textContent = message;
}

function reportFailure(action: string, error: unknown): void {
    setStatus(`${action} failed: ${error instanceof Error ? error.message : String(error)}`);
}

async function loadProject(host: StandaloneHost, project: BrowserProject, automatic = false): Promise<void> {
    if (automatic && !startupRestoreActive) {
        return;
    }
    if (!automatic) {
        startupRestoreActive = false;
    }
    const rootPath = await host.loadProject(project);
    activeBrowserWorkspaceId = project.id;

    expandedFolders.clear();
    projectFolderPaths(host.getProjectTextPaths()).forEach(path => expandedFolders.add(path));
    renderProjectState(host);
    setStatus(`Opened ${rootPath} (${project.files.length} files)`);
}

function renderProjectState(host: StandaloneHost): void {
    const projectOpen = host.getProjectTextPaths().length > 0;
    document.body.dataset.projectOpen = String(projectOpen);
    getControls().welcomePage.hidden = projectOpen;
    renderChromeState(host, projectOpen);
    renderProjectFiles(host);
    renderProjectDiagnostics(host);
}

function renderChromeState(host: StandaloneHost, projectOpen: boolean): void {
    const controls = getControls();
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
        await loadProject(host, project);
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

function redirectToServerLogin(): void {
    const loginUrl = new URL('web-auth/login', document.baseURI);
    loginUrl.searchParams.set('return_to', `${window.location.pathname}${window.location.search}`);
    window.location.assign(loginUrl);
}

async function openRemoteProjectDialog(): Promise<void> {
    try {
        if ((await fetchWebSession()).status === 401) {
            redirectToServerLogin();
            return;
        }
    } catch {
        // Static deployments have no session endpoint.
    }
    const controls = getControls();
    remoteProjectToCreate = undefined;
    controls.remoteProjectError.textContent = '';
    controls.remoteProjectConnectButton.textContent = 'Connect';
    controls.remoteProjectDialog.showModal();
    controls.remoteProjectName.select();
}

async function connectRemoteProject(host: StandaloneHost): Promise<void> {
    const controls = getControls();
    controls.remoteProjectConnectButton.disabled = true;
    controls.remoteProjectError.textContent = '';
    setStatus('Connecting to project server...');
    try {
        const projectName = controls.remoteProjectName.value.trim();
        const apiUrl = new URL('api/projects/', document.baseURI).toString();
        const project = remoteProjectToCreate === projectName
            ? await createRemoteProject(projectName, apiUrl)
            : await loadRemoteProject(projectName, apiUrl);
        await loadProject(host, project);
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
    const controls = getControls();
    controls.newFileError.textContent = '';
    controls.newFilePath.value = '';
    controls.newFileDialog.showModal();
    controls.newFilePath.focus();
}

async function createTextFile(host: StandaloneHost): Promise<void> {
    const controls = getControls();
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

async function openBrowserWorkspaceDialog(host: StandaloneHost): Promise<void> {
    const controls = getControls();
    const summaries = await browserWorkspaces.list();
    if (summaries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'workspace-list-empty';
        empty.textContent = 'No browser workspaces yet.';
        controls.workspaceList.replaceChildren(empty);
    } else {
        controls.workspaceList.replaceChildren(...summaries.map(summary => {
            const row = document.createElement('div');
            row.className = 'workspace-list-row';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'workspace-list-item';
            button.textContent = summary.name;
            button.title = summary.rootPath;
            button.addEventListener('click', () => {
                void browserWorkspaces.open(summary.id)
                    .then(project => loadProject(host, project))
                    .then(() => controls.workspaceDialog.close())
                    .catch(error => reportFailure('Open workspace', error));
            });
            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'workspace-delete-button';
            deleteButton.textContent = 'Delete';
            deleteButton.disabled = summary.id === activeBrowserWorkspaceId;
            if (deleteButton.disabled) {
                deleteButton.title = 'Open another project before deleting this workspace.';
            }
            deleteButton.addEventListener('click', () => {
                if (!window.confirm(`Delete browser workspace "${summary.name}"?`)) {
                    return;
                }
                void browserWorkspaces.delete(summary.id)
                    .then(() => row.remove())
                    .catch(error => reportFailure('Delete workspace', error));
            });
            const reimportButton = document.createElement('button');
            reimportButton.type = 'button';
            reimportButton.className = 'workspace-reimport-button';
            reimportButton.textContent = 'Re-import';
            reimportButton.addEventListener('click', () => {
                reimportWorkspaceId = summary.id;
                controls.workspaceDialog.close();
                controls.openFolderInput.click();
            });
            row.append(button, reimportButton, deleteButton);
            return row;
        }));
    }
    controls.workspaceDialog.showModal();
}

function openImportFolder(input: HTMLInputElement): void {
    startupRestoreActive = false;
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
    const supportsLocalFolderAccess = typeof (window as BrowserFilePickerWindow).showDirectoryPicker === 'function';
    controls.openFolderButton.hidden = !supportsLocalFolderAccess;
    controls.welcomeOpenFolderButton.hidden = !supportsLocalFolderAccess;
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
        startupRestoreActive = false;
        openSingleFile(host, controls.openFileInput).catch(error => reportFailure('Open', error));
    });
    controls.openFolderButton.addEventListener('click', () => {
        startupRestoreActive = false;
        openFolder(host, controls.openFolderInput).catch(error => reportFailure('Open', error));
    });
    controls.importFolderButton.addEventListener('click', () => openImportFolder(controls.openFolderInput));
    controls.openWorkspaceButton.addEventListener('click', () => {
        startupRestoreActive = false;
        openBrowserWorkspaceDialog(host).catch(error => reportFailure('Open workspace', error));
    });
    controls.openRemoteButton.addEventListener('click', () => {
        startupRestoreActive = false;
        void openRemoteProjectDialog();
    });
    controls.welcomeOpenFolderButton.addEventListener('click', () => {
        startupRestoreActive = false;
        openFolder(host, controls.openFolderInput).catch(error => reportFailure('Open', error));
    });
    controls.welcomeImportFolderButton.addEventListener('click', () => openImportFolder(controls.openFolderInput));
    controls.welcomeOpenDemoButton.addEventListener('click', () => {
        startupRestoreActive = false;
        loadDefaultDemoProject(host).catch(error => reportFailure('Load demo', error));
    });
    controls.welcomeOpenWorkspaceButton.addEventListener('click', () => {
        startupRestoreActive = false;
        openBrowserWorkspaceDialog(host).catch(error => reportFailure('Open workspace', error));
    });
    controls.welcomeOpenRemoteButton.addEventListener('click', () => {
        startupRestoreActive = false;
        void openRemoteProjectDialog();
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
    const button = getControls().logoutButton;
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

async function restoreLastBrowserWorkspace(host: StandaloneHost): Promise<void> {
    const [summary] = await browserWorkspaces.list();
    if (summary) {
        await loadProject(host, await browserWorkspaces.open(summary.id), true);
    }
    startupRestoreActive = false;
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
    initialText: '',
    settings: DEFAULT_STANDALONE_PREVIEW_SETTINGS,
    onStateChange: renderProjectState
});
bindProjectControls(host);
void bindLogoutControl();
window.addEventListener('pagehide', () => { void host.flushProjectWrites(); });
renderProjectState(host);
void restoreLastBrowserWorkspace(host).catch(() => undefined);
