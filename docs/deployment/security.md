# Security Model

This page defines the boundary for the server edition. Static SnapTeX has no remote project API or login surface; its project permissions come from browser storage and directory-handle APIs.

Before exposing SnapTeX Server, verify all of the following:

- it has a dedicated HTTPS origin;
- Node listens only on loopback;
- the service runs as a dedicated non-root account;
- the project root contains only projects intended for remote access;
- `apps/web/server.env` is private and uses a unique long password;
- backups cover project data independently of application deployment.

## Trust boundary

Use a dedicated origin such as `https://snaptex.example.com`. Browser storage, cookies, service workers, and JavaScript authority are isolated by origin, not URL path. Hosting unrelated applications under the same origin makes every same-origin application part of the same trust boundary.

## Authentication and sessions

Remote projects use the built-in Web Session flow:

- credentials are read from the private server environment;
- successful login creates an `HttpOnly`, `Secure`, `SameSite=Strict` host cookie;
- sessions are opaque, server-side, revocable, and bounded to eight hours by default or 30 days when the user explicitly selects the trusted-device option;
- session state is stored with owner-only permissions in the service state directory so deployment swaps and service restarts do not force a new login;
- state-changing requests require a matching origin and CSRF token;
- the welcome page and local-only features do not require login.

Project history stores only a remote project name, never a username, password, session ID, or CSRF token. Session cookies remain unavailable to browser JavaScript. Signing out revokes the current server-side session, including a remembered session.

Failed logins are tracked by source IP. Ten failures within 30 minutes block that IP for 30 days. The bounded in-memory block list resets with the Node service; use firewall or fail2ban controls when persistent bans are required.

## File authorization

The project API:

- accepts only a constrained project-name format;
- resolves and revalidates real paths beneath `SNAPTEX_PROJECTS_ROOT`;
- rejects symbolic links and hidden path segments;
- limits readable project extensions;
- allows writes only to supported text formats;
- limits request body size;
- uses temporary files and atomic rename for replacement writes.

## Process isolation

The installer runs SnapTeX as a dedicated non-root account. Its systemd unit removes capabilities, restricts device and kernel access, mounts the installed runtime read-only, and grants write access only to the configured project root.

## HTTP defenses

The Node service sends a restrictive Content Security Policy, frame denial, no-sniff, no-referrer, same-origin opener/resource policies, and a limited Permissions Policy. Active SVG project resources receive an additional sandbox policy.

Nginx should expose only the loopback service over HTTPS. Do not bind the Node listener directly to a public network interface.

## Secrets

Keep `apps/web/server.env` out of Git. The installer writes a root-readable environment file outside the runtime. Never place real origins, usernames, passwords, tokens, or private project paths in repository documentation or examples.

Return to [SnapTeX Server](./server.md) for installation and operational commands.
