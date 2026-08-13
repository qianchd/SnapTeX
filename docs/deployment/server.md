# SnapTeX Server

SnapTeX Server is an independent Node.js service. The editor shell, local folders, imported workspaces, and demo remain public. Only remote project access requires authentication.

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

## Nginx and TLS

Copy the included virtual-host template and replace the example hostname and port:

```bash
cp apps/web/deploy/nginx-site.conf /etc/nginx/sites-available/snaptex.example.com
ln -s /etc/nginx/sites-available/snaptex.example.com /etc/nginx/sites-enabled/snaptex.example.com
nginx -t && systemctl reload nginx
certbot --nginx -d snaptex.example.com
```

Nginx terminates TLS and proxies the complete origin to the loopback Node service. The application itself owns login, sessions, API authorization, and static assets.

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

See [Security Model](./security.md) before exposing a deployment publicly.
