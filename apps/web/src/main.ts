import { createStandaloneSnapTeXApp } from '../../standalone/src/app';

const SPLITTER_WIDTH_PX = 6;
const MIN_EDITOR_WIDTH_PX = 280;
const MIN_PREVIEW_WIDTH_PX = 360;

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

createStandaloneSnapTeXApp({
    editorParent,
    initialText: INITIAL_TEX
});
