# SnapTeX Web server deployment

The Web server is deployed from a complete SnapTeX source tree. Building locally and copying `dist-web` is not required.

## Requirements

- Linux with Node.js 22 or later, npm, bash, curl, and systemd.
- A copied or cloned SnapTeX source tree. Prefer `git clone`/`git pull` or a source archive; do not recursively copy local `node_modules`, `.vscode-test`, build output, or VSIX files.
- A projects directory whose direct child directories are LaTeX projects.
- `sudo` access when installing outside the current account or registering the system service.

## Configure and install

From the server-side source root:

```bash
cp apps/web/server.env.example apps/web/server.env
```

Edit `apps/web/server.env`. Quote values that contain spaces:

```dotenv
SNAPTEX_PROJECTS_ROOT=/srv/snaptex/projects
SNAPTEX_INSTALL_DIR=/opt/snaptex-web
SNAPTEX_SERVICE_NAME=snaptex-web
SNAPTEX_RUN_USER=user
HOST=localhost
PORT=3000
```

Systemd deployment and projects paths must not contain whitespace. With the example above, entering `demo` in **Open Server** opens `/srv/snaptex/projects/demo`; if it does not exist, SnapTeX offers to create it with a minimal `main.tex`.

`SNAPTEX_RUN_USER` defaults to the account running the installer. Then run:

```bash
npm run web:install-server
```

The command performs the complete deployment:

1. Installs exact dependencies with `npm ci`.
2. Builds `dist-web` and runs the server API test.
3. Installs only `dist-web` and `apps/web/server.mjs` into `SNAPTEX_INSTALL_DIR`.
4. Generates the systemd environment and unit from the repository template.
5. Enables and restarts the service.
6. Checks `/api/projects` and restores the previous runtime if startup fails.

The source directory remains the deployment input. The installed runtime and project collection are separate and can be replaced or backed up independently.

## Operate and update

```bash
systemctl status snaptex-web.service
journalctl -u snaptex-web.service -f
```

To update, replace the source tree or run `git pull`, preserve `apps/web/server.env`, and run the same command again:

```bash
npm run web:install-server
```

The previous runtime remains at `<SNAPTEX_INSTALL_DIR>.previous` after a successful update. The installer never copies, deletes, or replaces `SNAPTEX_PROJECTS_ROOT`; project creation and text-file edits happen only through the running project API.

The default service listens only on `127.0.0.1`. Use an SSH tunnel for private access:

```bash
ssh -N -L 3001:localhost:3000 server
```

Then open `http://127.0.0.1:5190/`. Public deployments should use an authenticated HTTPS reverse proxy rather than exposing the Node.js listener directly.
