# SnapTeX Server

SnapTeX Server is an independent Node.js service. The editor shell, local folders, imported workspaces, and demo remain public. Only remote project access requires authentication.

Use this edition only when project files must stay on the server. For GitHub Pages or local/browser-managed projects, follow [Static Web and PWA](./static-web.md) instead.

## Requirements

- Linux with Node.js 22 or later, npm, bash, curl, systemd, Nginx, and Certbot;
- the `acl` package and permission to create a system service account;
- a complete SnapTeX source tree;
- a projects directory whose direct children are named LaTeX projects;
- a dedicated HTTPS origin such as `https://snaptex.example.com`.

## Configure

```bash
git clone https://github.com/qianchd/SnapTeX.git
cd SnapTeX
cp apps/web/server.env.example apps/web/server.env
```

Edit the private configuration:

```dotenv
SNAPTEX_PROJECTS_ROOT=/srv/snaptex/projects
SNAPTEX_INSTALL_DIR=/opt/snaptex-web
SNAPTEX_SERVICE_NAME=snaptex-web
SNAPTEX_RUN_USER=snaptex
HOST=localhost
PORT=3000
SNAPTEX_AUTH_USERNAME=snaptex-admin
SNAPTEX_AUTH_PASSWORD=replace-with-a-long-random-password
SNAPTEX_PUBLIC_ORIGIN=https://snaptex.example.com
SNAPTEX_PUBLIC_PATH=/
```

`SNAPTEX_PUBLIC_ORIGIN` is an HTTPS origin without a path. Keep `HOST` on loopback and expose the service only through HTTPS.

| Variable | Purpose |
| --- | --- |
| `SNAPTEX_PROJECTS_ROOT` | Parent directory whose direct children are remotely openable project names. |
| `SNAPTEX_INSTALL_DIR` | Installer-managed runtime directory; do not point it at the source checkout. |
| `SNAPTEX_SERVICE_NAME` | systemd unit name used by install, status, logs, and updates. |
| `SNAPTEX_RUN_USER` | Dedicated non-login OS account used by the service. |
| `HOST` / `PORT` | Loopback listener consumed by Nginx. Keep `HOST` as `localhost`, `127.0.0.1`, or `::1`. |
| `SNAPTEX_AUTH_USERNAME` / `SNAPTEX_AUTH_PASSWORD` | Built-in remote-project login. Use a unique username and a long random password. |
| `SNAPTEX_PUBLIC_ORIGIN` | Exact public HTTPS origin used for origin and cookie checks, for example `https://snaptex.example.com`. |
| `SNAPTEX_PUBLIC_PATH` | URL base path. Use `/` for the recommended dedicated-origin deployment. |

`apps/web/server.env` is ignored by Git. Protect the source checkout and configuration so only administrators can read the credentials.

## Install

```bash
npm run web:install-server
```

The installer:

1. validates the private configuration;
2. creates a non-login service account when necessary;
3. grants scoped ACL access to the project tree;
4. runs `npm ci`, builds the server edition, and runs server tests;
5. validates and installs a hardened systemd unit;
6. atomically switches the runtime and checks `/healthz`;
7. restores the previous runtime if deployment fails.

The production build minifies browser JavaScript and precompresses eligible text assets with Brotli and gzip. The Node service prefers Brotli, falls back to gzip, and serves the original file when neither encoding is accepted. It also supplies per-file ETags, `304 Not Modified` responses, immutable caching for content-versioned URLs, and revalidation caching for HTML and `service-worker.js`. API, authentication, and project-file responses remain `no-store`.

After installation, `systemctl status snaptex-web` should show an active service and `curl http://127.0.0.1:3000/healthz` should return a successful health response. Replace the service name and port when your configuration differs.

## Nginx and TLS

Copy the included virtual-host template and replace the example hostname and port:

```bash
cp apps/web/deploy/nginx-site.conf /etc/nginx/sites-available/snaptex.example.com
ln -s /etc/nginx/sites-available/snaptex.example.com /etc/nginx/sites-enabled/snaptex.example.com
nginx -t && systemctl reload nginx
certbot --nginx -d snaptex.example.com
```

Nginx terminates TLS and proxies the complete origin to the loopback Node service. The application itself owns login, sessions, API authorization, and static assets.

Visit the public origin after Certbot completes. The welcome page, demo, local folder, and imported workspace remain public; **Open Server** asks for the configured credentials before exposing remote project names or files.

## Project layout

If `SNAPTEX_PROJECTS_ROOT=/srv/snaptex/projects`, entering project name `paper-one` opens `/srv/snaptex/projects/paper-one`. Missing projects can be created after confirmation.

The API exposes only allowlisted project files and rejects hidden paths, traversal, symbolic-link escapes, unsupported writes, and files outside the selected project.

## Operate

```bash
systemctl status snaptex-web
journalctl -u snaptex-web -f
curl http://127.0.0.1:3000/healthz
```

To update, pull or replace the source tree and rerun `npm run web:install-server` with the same private configuration.

Before upgrades, back up `SNAPTEX_PROJECTS_ROOT` independently. The installer rolls back application runtime failures, not user project content or administrator configuration mistakes.

See [Security Model](./security.md) before exposing a deployment publicly.

## Verify the public service

1. Open the public origin and confirm local-only actions work without login.
2. Choose **Open Server**, sign in, and open one allowlisted project by name.
3. Save a synthetic text change, reload, and verify the server file changed.
4. Confirm an invalid project name, hidden path, unsupported extension, and unauthenticated write are rejected.
5. Review service logs and back up the project root before making the deployment available to other users.
