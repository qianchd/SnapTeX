# Deployment Overview

SnapTeX Web has two explicit deployment modes built from the same UI.

| Mode | Command | Remote projects | Offline PWA |
| --- | --- | --- | --- |
| Static | `npm run web:build-static` | No | Yes |
| Server | `npm run web:build-server` | Yes, authenticated | Application shell only; projects require the server |

## Static Web

Use the static build for GitHub Pages, object storage, or any ordinary static host. It supports local directory handles, browser workspaces, the demo, project ZIP export, and offline application assets.

[Static deployment guide](./static-web.md)

## SnapTeX Server

Use the server build when project files should remain on a machine you control and be accessed by project name. The Node service adds login, server-side sessions, CSRF checks, and a constrained project file API.

[Server deployment guide](./server.md)

## Android status

The repository reserves `apps/android` for a future wrapper around the standalone host. There is currently no production APK build. The reusable core and standalone host are already separated so the Android shell can reuse them without embedding VS Code APIs.
