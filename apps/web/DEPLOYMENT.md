# SnapTeX Server deployment

The maintained deployment guide now lives in the documentation site:

- [SnapTeX Server](../../docs/deployment/server.md)
- [Security Model](../../docs/deployment/security.md)

From a server-side source checkout, the installation entry remains:

```bash
cp apps/web/server.env.example apps/web/server.env
npm run web:install-server
```

Use the full guide before exposing the service publicly. It documents the private environment, dedicated origin, loopback listener, Nginx/TLS setup, project authorization, updates, and rollback behavior.
