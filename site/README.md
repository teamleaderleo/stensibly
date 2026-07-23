# Stensibly public dashboard

This directory is a static read-only dashboard for a remotely hosted Stensibly API.

It can be deployed independently from the Bun service. In Vercel, import the repository and set the project root directory to `site`.

Suggested split:

- `stensibly.com` — public landing page and dashboard connector
- `stensibly.app` — the same dashboard, or a later authenticated application
- durable API host — long-running Bun process with persistent SQLite, exposed through a separate API hostname

The dashboard asks the user for:

- the API base URL
- a Stensibly token carrying `read` scope

The API endpoint is stored in `localStorage`. The raw token is stored only in `sessionStorage` and disappears when the browser session ends.

Allow the deployed dashboard origin on the API process:

```bash
STENSIBLY_REQUIRE_AUTH=true \
STENSIBLY_ALLOWED_ORIGINS=https://stensibly.com,https://stensibly.app \
  bun run start
```

Create a read-only token for the dashboard:

```bash
bun run tokens create \
  --name dashboard \
  --scopes read \
  --projects scrapbook
```

The static site never receives or stores the SQLite database. It reads `/api/items` over HTTPS and renders status totals, active claimants, lease times, and the project board.
