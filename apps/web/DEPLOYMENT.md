# SnapTeX Server deployment

SnapTeX Server is an independent Node.js service. The editor shell, local folders, and demo are public; remote projects require its login, server-side browser sessions, CSRF validation, and project-file authorization. Nginx only terminates HTTPS and proxies `snaptex.example.com` to the loopback listener.

## Requirements

- Linux with Node.js 22 or later, npm, bash, curl, systemd, Nginx, and Certbot.
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
SNAPTEX_PUBLIC_PATH=/
```

`SNAPTEX_PUBLIC_ORIGIN` is the external HTTPS origin without a path. `SNAPTEX_PUBLIC_PATH` is the path exposed by Nginx. If `SNAPTEX_RUN_USER` does not exist, the installer creates it as a non-login system account. It grants that account traversal on parent directories and inherited read/write ACLs only on `SNAPTEX_PROJECTS_ROOT`; ownership and existing ACL entries are preserved.

Run the installer:

```bash
npm run web:install-server
```

It installs exact dependencies, builds and tests the Web app, installs the runtime, writes a root-readable environment file and hardened systemd unit, restarts the loopback service, and rolls back the runtime if `/healthz` does not become ready. It does not edit Nginx or depend on another service.

## Nginx

Install the dedicated virtual host:

```bash
cp apps/web/deploy/nginx-site.conf /etc/nginx/sites-available/snaptex.example.com
ln -s /etc/nginx/sites-available/snaptex.example.com /etc/nginx/sites-enabled/snaptex.example.com
nginx -t && systemctl reload nginx
certbot --nginx -d snaptex.example.com
```

If the symlink already exists, omit the `ln` command. Revalidate Nginx after Certbot updates the virtual host:

```bash
nginx -t && systemctl reload nginx
```

Open `https://snaptex.example.com/`. Anonymous users can use the welcome page, local folders, and demo without signing in. Choosing **Open Server** starts SnapTeX's login flow, and unauthenticated project API requests return `401`. The Node listener remains inaccessible from the public network.

Login failures are tracked per source IP. Ten failures within 30 minutes block that IP for 30 days without affecting other users. The bounded in-memory block list is cleared when the Node service restarts; use a host firewall or fail2ban as an additional layer if bans must survive service restarts.

## Operate and update

```bash
systemctl status snaptex-web.service
journalctl -u snaptex-web.service -f
```

After updating the source tree, preserve `apps/web/server.env` and run `npm run web:install-server` again. The previous runtime remains at `<SNAPTEX_INSTALL_DIR>.previous`; the installer never replaces or deletes the projects directory.

The browser-session routes are `/web-auth/login`, `/web-auth/session`, `/web-auth/logout`, and `/web-auth/check`. They intentionally use the same HTTP contract as gpt-web-connecter while remaining a separate implementation and deployment. A future joint server can mount the SnapTeX handler behind one shared authentication implementation without introducing service-to-service authentication today.
