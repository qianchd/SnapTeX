import { createStandaloneSnapTeXApp, type StandaloneHost } from '../../standalone/src/app';
import type { BrowserProjectFile, BrowserWritableFileHandle } from '../../standalone/src/browser-file-provider';

const SPLITTER_WIDTH_PX = 6;
const MIN_EDITOR_WIDTH_PX = 280;
const MIN_PREVIEW_WIDTH_PX = 360;
const PROJECT_TEXT_FILE_PATTERN = /\.(?:tex|bib|sty|cls|bst|txt)$/i;
const PROJECT_RESOURCE_FILE_PATTERN = /\.(?:pdf|png|jpe?g|gif|svg|webp|bmp)$/i;

interface BrowserFileHandle extends BrowserWritableFileHandle {
    kind: 'file';
    name: string;
    getFile(): Promise<File>;
}

interface BrowserDirectoryHandle {
    kind: 'directory';
    name: string;
    values(): AsyncIterable<BrowserFileHandle | BrowserDirectoryHandle>;
}

interface BrowserFilePickerWindow extends Window {
    showOpenFilePicker?: (options?: {
        multiple?: boolean;
        types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<BrowserFileHandle[]>;
    showDirectoryPicker?: () => Promise<BrowserDirectoryHandle>;
}

function enableSplitPaneResize(splitter: HTMLElement): void {
    const shell = document.getElementById('app-shell');
    if (!shell) {
        return;
    }

    const setEditorWidth = (clientX: number): void => {
        const rect = shell.getBoundingClientRect();
        const maxWidth = Math.max(MIN_EDITOR_WIDTH_PX, rect.width - MIN_PREVIEW_WIDTH_PX - SPLITTER_WIDTH_PX);
        const width = Math.min(maxWidth, Math.max(MIN_EDITOR_WIDTH_PX, clientX - rect.left));
        shell.style.setProperty('--snaptex-web-editor-width', `${width}px`);
    };

    const endResize = (event: PointerEvent): void => {
        document.body.classList.remove('is-resizing-split');
        if (splitter.hasPointerCapture(event.pointerId)) {
            splitter.releasePointerCapture(event.pointerId);
        }
    };

    splitter.addEventListener('pointerdown', event => {
        splitter.setPointerCapture(event.pointerId);
        document.body.classList.add('is-resizing-split');
        setEditorWidth(event.clientX);
        event.preventDefault();
    });
    splitter.addEventListener('pointermove', event => {
        if (splitter.hasPointerCapture(event.pointerId)) {
            setEditorWidth(event.clientX);
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function reportFailure(action: string, error: unknown): void {
    setStatus(`${action} failed: ${errorMessage(error)}`);
}

function isProjectTextFile(path: string): boolean {
    return PROJECT_TEXT_FILE_PATTERN.test(path);
}

function isProjectFile(path: string): boolean {
    return isProjectTextFile(path) || PROJECT_RESOURCE_FILE_PATTERN.test(path);
}

function chooseRootPath(files: readonly BrowserProjectFile[]): string | undefined {
    const texPaths = files.map(file => file.path).filter(path => /\.tex$/i.test(path));
    return texPaths.find(path => /\/main\.tex$/i.test(path))
        ?? texPaths.find(path => /\/root\.tex$/i.test(path))
        ?? texPaths[0];
}

function projectTextPaths(files: readonly BrowserProjectFile[]): string[] {
    return files
        .map(file => file.path)
        .filter(isProjectTextFile)
        .sort((a, b) => a.localeCompare(b));
}

function isTexFile(path: string): boolean {
    return /\.tex$/i.test(path);
}

async function projectFileFromFile(file: File, path: string, handle?: BrowserFileHandle): Promise<BrowserProjectFile> {
    const projectFile: BrowserProjectFile = {
        path,
        blob: file,
        handle
    };
    if (isProjectTextFile(path)) {
        projectFile.readText = () => file.text();
    }
    return projectFile;
}

async function projectFileFromHandle(handle: BrowserFileHandle, path: string): Promise<BrowserProjectFile> {
    if (isProjectTextFile(path)) {
        return {
            path,
            handle,
            readText: async () => (await handle.getFile()).text()
        };
    }
    return projectFileFromFile(await handle.getFile(), path, handle);
}

function fileInputPath(file: File): string {
    return `/${(file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name}`;
}

async function readDirectoryHandle(directory: BrowserDirectoryHandle, prefix = ''): Promise<BrowserProjectFile[]> {
    const files: BrowserProjectFile[] = [];
    for await (const entry of directory.values()) {
        const path = `${prefix}/${entry.name}`;
        if (entry.kind === 'directory') {
            files.push(...await readDirectoryHandle(entry, path));
            continue;
        }
        if (isProjectFile(path)) {
            files.push(await projectFileFromHandle(entry, path));
        }
    }
    return files;
}

async function loadProject(host: StandaloneHost, files: readonly BrowserProjectFile[]): Promise<void> {
    const rootPath = chooseRootPath(files);
    if (!rootPath) {
        setStatus('No TeX file found.');
        return;
    }

    await host.loadProject(files, rootPath);
    renderProjectFiles(host, projectTextPaths(files));
    setStatus(`Opened ${rootPath} (${files.length} files)`);
}

function renderProjectFiles(host: StandaloneHost, paths: readonly string[]): void {
    const fileList = document.getElementById('project-files');
    if (!fileList) {
        return;
    }

    fileList.replaceChildren(...paths.map(path => {
        const entry = document.createElement('span');
        const openButton = document.createElement('button');
        openButton.type = 'button';
        openButton.className = 'project-file-open';
        openButton.textContent = path.replace(/^\//, '');
        openButton.title = path;
        openButton.dataset.active = String(path === host.getActivePath());
        openButton.addEventListener('click', () => {
            host.openEditorFile(path)
                .then(() => {
                    renderProjectFiles(host, paths);
                    setStatus(`Editing ${path}`);
                })
                .catch(error => reportFailure('Open file', error));
        });

        entry.className = 'project-file-entry';
        entry.dataset.root = String(path === host.getRootPath());
        entry.append(openButton);
        if (isTexFile(path)) {
            const rootButton = document.createElement('button');
            rootButton.type = 'button';
            rootButton.className = 'project-root-button';
            rootButton.textContent = path === host.getRootPath() ? 'root' : 'set root';
            rootButton.disabled = path === host.getRootPath();
            rootButton.title = path === host.getRootPath() ? 'Preview root' : `Set ${path} as preview root`;
            rootButton.addEventListener('click', () => {
                host.setPreviewRoot(path)
                    .then(() => {
                        renderProjectFiles(host, paths);
                        setStatus(`Preview root ${path}`);
                    })
                    .catch(error => reportFailure('Set root', error));
            });
            entry.append(rootButton);
        }
        return entry;
    }));
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
    if (result.wroteToSource) {
        setStatus(`Saved ${result.path}`);
        return;
    }

    downloadText(result.path, result.text);
    setStatus(`Downloaded ${result.path}`);
}

function bindProjectControls(host: StandaloneHost): void {
    const openFileButton = document.getElementById('open-file-button');
    const openFolderButton = document.getElementById('open-folder-button');
    const saveButton = document.getElementById('save-button');
    const openFileInput = document.getElementById('open-file-input') as HTMLInputElement | null;
    const openFolderInput = document.getElementById('open-folder-input') as HTMLInputElement | null;
    if (!openFileButton || !openFolderButton || !saveButton || !openFileInput || !openFolderInput) {
        throw new Error('Missing web project controls.');
    }

    openFileButton.addEventListener('click', () => {
        openSingleFile(host, openFileInput).catch(error => reportFailure('Open', error));
    });
    openFolderButton.addEventListener('click', () => {
        openFolder(host, openFolderInput).catch(error => reportFailure('Open', error));
    });
    saveButton.addEventListener('click', () => {
        saveActiveFile(host).catch(error => reportFailure('Save', error));
    });

    openFileInput.addEventListener('change', () => {
        const file = openFileInput.files?.[0];
        if (file) {
            projectFileFromFile(file, `/${file.name}`)
                .then(projectFile => loadProject(host, [projectFile]))
                .catch(error => reportFailure('Open', error));
        }
        openFileInput.value = '';
    });
    openFolderInput.addEventListener('change', () => {
        const files = Array.from(openFolderInput.files ?? [])
            .filter(file => isProjectFile(fileInputPath(file)));
        Promise.all(files.map(file => projectFileFromFile(file, fileInputPath(file))))
            .then(projectFiles => loadProject(host, projectFiles))
            .catch(error => reportFailure('Open', error));
        openFolderInput.value = '';
    });
}

const INITIAL_TEX = String.raw`\title{SnapTeX Standalone Preview}
\author{CodeMirror Browser Prototype}
\date{\today}

\begin{document}
\maketitle

\section{Hello SnapTeX}

This is the first browser-hosted SnapTeX preview. It reuses the shared parser,
renderer, preview runtime, and virtualization pipeline.

\begin{equation}\label{eq:demo}
    a^2 + b^2 = c^2
\end{equation}

Equation~\ref{eq:demo} is rendered by the same KaTeX rule path used by the VS Code extension.

\end{document}
`;

const editorParent = document.getElementById('editor');
if (!editorParent) {
    throw new Error('Missing #editor container.');
}

const splitter = document.getElementById('splitter');
if (splitter) {
    enableSplitPaneResize(splitter);
}

const host = createStandaloneSnapTeXApp({
    editorParent,
    initialText: INITIAL_TEX
});
bindProjectControls(host);
