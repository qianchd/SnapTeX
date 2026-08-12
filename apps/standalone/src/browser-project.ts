import { normalizeBrowserPath, type BrowserProjectFile } from './browser-file-provider';

const PROJECT_TEXT_FILE_PATTERN = /\.(?:tex|bib|sty|cls|bst|txt)$/i;
const PROJECT_RESOURCE_FILE_PATTERN = /\.(?:pdf|png|jpe?g|gif|svg|webp|bmp)$/i;

export interface ProjectTreeNode {
    name: string;
    path: string;
    kind: 'file' | 'folder';
    children: ProjectTreeNode[];
}

export function isProjectTextFile(path: string): boolean {
    return PROJECT_TEXT_FILE_PATTERN.test(path);
}

export function isProjectFile(path: string): boolean {
    return isProjectTextFile(path) || PROJECT_RESOURCE_FILE_PATTERN.test(path);
}

export function isTexFile(path: string): boolean {
    return /\.tex$/i.test(path);
}

export function chooseRootPath(files: readonly BrowserProjectFile[]): string | undefined {
    const texPaths = files.map(file => file.path).filter(isTexFile);
    return texPaths.find(path => /\/main\.tex$/i.test(path))
        ?? texPaths.find(path => /\/root\.tex$/i.test(path))
        ?? texPaths[0];
}

export function projectFolderPaths(paths: readonly string[]): string[] {
    const folders = new Set<string>();
    for (const path of paths.map(normalizeBrowserPath)) {
        const parts = path.split('/').filter(Boolean);
        let currentPath = '';
        for (let index = 0; index < parts.length - 1; index++) {
            currentPath += `/${parts[index]}`;
            folders.add(currentPath);
        }
    }
    return [...folders].sort((a, b) => a.localeCompare(b));
}

export function createProjectTree(paths: readonly string[]): ProjectTreeNode {
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
