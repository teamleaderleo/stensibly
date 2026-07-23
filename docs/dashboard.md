# Dashboard and deployment split

Stensibly has two dashboard surfaces:

1. The Bun service renders a local interactive control room at `/`. It can create and claim work and perform simple lifecycle actions.
2. The static `site/` application is a read-only remote viewer intended for Vercel or another static host.

The static dashboard connects to `/api/items` on a durable Stensibly service using a read-scoped Bearer token. It never hosts the database and never proxies writes.

## Recommended domains

A reasonable first deployment is:

```text
stensibly.com
  static site/ dashboard on Vercel

api.stensibly.com
  Bun service on a persistent host
  REST at /api
  remote MCP at /mcp
  durable SQLite volume
```

`stensibly.app` can point at the same static deployment initially, or later become the authenticated application surface.

## Browser security

The API accepts browser requests only from origins named in `STENSIBLY_ALLOWED_ORIGINS`. Use exact HTTPS origins without paths.

```bash
STENSIBLY_ALLOWED_ORIGINS=https://stensibly.com,https://stensibly.app
```

The dashboard keeps the API endpoint in local storage. It keeps the raw token only in session storage. Use a dedicated read-only, project-scoped token and revoke it if the browser environment becomes untrusted.
