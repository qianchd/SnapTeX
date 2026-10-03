import * as assert from 'assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as vscode from 'vscode';
import { resolveProjectResource } from '../../../apps/vscode/src/panel';
import { VscodeFileProvider } from '../../../apps/vscode/src/vscode-file-provider';
import { PreviewUpdateService } from '../../preview-update-service';
import { normalizeUri } from '../../utils';

suite('VS Code adapter', () => {
    test('activates the bundled extension and registers its public commands', async () => {
        const extension = vscode.extensions.getExtension('qstatsite.snaptex');
        assert.ok(extension, 'The development extension must be installed');
        await extension.activate();
        assert.equal(extension.isActive, true);
        const commands = await vscode.commands.getCommands();
        for (const { command } of extension.packageJSON.contributes.commands) {
            assert.ok(commands.includes(command), `Missing command: ${command}`);
        }
    });

    test('renders included dirty editors and maps their source through both backends', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'snaptex-vscode-'));
        const root = vscode.Uri.file(directory);
        const main = vscode.Uri.joinPath(root, 'main.tex');
        const part = vscode.Uri.joinPath(root, 'part.tex');
        const provider = new VscodeFileProvider();
        const localHistory = vscode.workspace.getConfiguration('workbench.localHistory');
        const previousHistory = localHistory.inspect<boolean>('enabled')?.globalValue;
        try {
            await localHistory.update('enabled', false, vscode.ConfigurationTarget.Global);
            await vscode.workspace.fs.writeFile(main, Buffer.from('\\begin{document}\n\\input{part}\n\\end{document}'));
            await vscode.workspace.fs.writeFile(part, Buffer.from('Disk paragraph.'));
            const document = await vscode.workspace.openTextDocument(part);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(part, new vscode.Range(0, 0, 0, document.lineAt(0).text.length), 'Unsaved paragraph with $x^2$.');
            assert.equal(await vscode.workspace.applyEdit(edit), true);
            assert.equal(document.isDirty, true);
            assert.equal(await provider.read(part), document.getText());

            for (const backendMode of ['legacy', 'ast(experimental)'] as const) {
                const service = new PreviewUpdateService(provider);
                const payload = await service.render(main, await provider.read(main), { backendMode, deferFullHtml: false });
                const html = payload.htmls?.join('\n') ?? '';
                assert.match(html, /Unsaved paragraph/);
                assert.match(html, /class="katex"/);
                assert.doesNotMatch(html, /Disk paragraph|katex-error/);
                const target = service.getPreviewSyncData(part.toString(), 0, 2);
                assert.ok(target, backendMode);
                const source = service.getSourceSyncData(target.index, target.ratio);
                assert.ok(source);
                assert.equal(normalizeUri(source.file), normalizeUri(part));
                assert.equal(source.line, 0);
            }
            await document.save();
        } finally {
            await localHistory.update('enabled', previousHistory, vscode.ConfigurationTarget.Global);
            await rm(directory, { recursive: true, force: true });
        }
    });

    test('resolves resources within the opened root on the native platform', () => {
        const root = vscode.Uri.file(join(tmpdir(), 'snaptex-project'));
        const source = vscode.Uri.joinPath(root, 'chapter/main.tex');
        for (const extension of ['pdf', 'png']) {
            const resource = resolveProjectResource(source, root, `../figures/a.${extension}`);
            assert.equal(resource?.relativePath, `figures/a.${extension}`);
            assert.equal(resource?.uri.toString(), vscode.Uri.joinPath(root, `figures/a.${extension}`).toString());
        }
        for (const path of ['../../outside.png', '../../snaptex-project/reentered.pdf', '/tmp/secret.pdf', 'C:/tmp/secret.pdf', 'https://example.com/a.pdf', 42]) {
            assert.equal(resolveProjectResource(source, root, path), undefined);
        }
    });


});
