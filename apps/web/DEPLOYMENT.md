# SnapTeX Server deployment

SnapTeX Server is an independent Node.js service. It owns its login, server-side browser sessions, CSRF validation, and project-file authorization. Nginx only terminates HTTPS and proxies `/snaptex/` to the loopback listener.

## Requirements

- Linux with Node.js 22 or later, npm, bash, curl, and systemd.
- A complete SnapTeX source tree and a projects directory whose direct children are LaTeX projects.
- The `acl` package (`setfacl`) and permission to create a system service account.
- An HTTPS Nginx virtual host for public access.

## Install

From the server-side source root:

```bash
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
SNAPTEX_AUTH_PASSWORD=<a long random password>
SNAPTEX_PUBLIC_ORIGIN=https://snaptex.example.com
SNAPTEX_PUBLIC_PATH=/snaptex/
```

`SNAPTEX_PUBLIC_ORIGIN` is the external HTTPS origin without a path. `SNAPTEX_PUBLIC_PATH` is the path exposed by Nginx. If `SNAPTEX_RUN_USER` does not exist, the installer creates it as a non-login system account. It grants that account traversal on parent directories and inherited read/write ACLs only on `SNAPTEX_PROJECTS_ROOT`; ownership and existing ACL entries are preserved.

Run the installer:

```bash
npm run web:install-server
```

It installs exact dependencies, builds and tests the Web app, installs the runtime, writes a root-readable environment file and hardened systemd unit, restarts the loopback service, and rolls back the runtime if `/healthz` does not become ready. It does not edit Nginx or depend on another service.

## Nginx

Add the locations from `apps/web/deploy/nginx-location.conf` to the existing HTTPS `server` block, or use the equivalent minimal configuration:

```nginx
location = /snaptex {
    return 308 /snaptex/;
}

location ^~ /snaptex/ {
    proxy_pass http://localhost:3000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Then validate and reload Nginx:

```bash
nginx -t && systemctl reload nginx
```

Open `https://snaptex.example.com/`. Anonymous page requests go to SnapTeX's own login page; API requests return `401`. The Node listener remains inaccessible from the public network.

## Operate and update

```bash
systemctl status snaptex-web.service
journalctl -u snaptex-web.service -f
```

After updating the source tree, preserve `apps/web/server.env` and run `npm run web:install-server` again. The previous runtime remains at `<SNAPTEX_INSTALL_DIR>.previous`; the installer never replaces or deletes the projects directory.

The browser-session routes are `/web-auth/login`, `/web-auth/session`, `/web-auth/logout`, and `/web-auth/check`. They intentionally use the same HTTP contract as gpt-web-connecter while remaining a separate implementation and deployment. A future joint server can mount the SnapTeX handler behind one shared authentication implementation without introducing service-to-service authentication today.
