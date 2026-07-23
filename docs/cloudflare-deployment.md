# Deploy the hosted gateway to Cloudflare Workers

The Cloudflare Worker is an additional hosted entrypoint for the same Convex-backed REST API and remote MCP gateway. It does not replace the local SQLite app, the static dashboard, the Convex deployment, or the existing Vercel entrypoint.

## Install and authenticate

```bash
bun install
bunx wrangler login
```

Wrangler opens a browser so you can authorize the Cloudflare account that should own the `stensibly-api` Worker.

## Configure local Worker development

Create an untracked `.dev.vars` file:

```dotenv
CONVEX_URL=https://your-production-deployment.convex.cloud
STENSIBLY_SERVICE_SECRET=the-same-secret-configured-in-convex-production
```

`wrangler.jsonc` supplies these non-secret defaults:

```text
STENSIBLY_WORKSPACE=default
STENSIBLY_ALLOWED_ORIGINS=https://stensibly.com,https://stensibly.app,https://stensibly.vercel.app
```

Start the Worker locally:

```bash
bun run worker:dev
```

Verify the public endpoint:

```bash
curl http://localhost:8787/health
```

## Configure production secrets

Set the Convex URL and service secret as encrypted Worker bindings. Wrangler prompts for each value and does not require putting them in shell history.

```bash
bunx wrangler secret put CONVEX_URL
bunx wrangler secret put STENSIBLY_SERVICE_SECRET
```

Use the production Convex URL, such as:

```text
https://resilient-donkey-323.convex.cloud
```

Use the exact service secret already configured in the production Convex deployment. Do not create a second value.

## Deploy

```bash
bun run worker:deploy
```

Wrangler prints the Worker URL, normally under your account's `workers.dev` subdomain. Verify it before attaching a custom domain:

```bash
curl https://YOUR-WORKER.workers.dev/health
curl -i https://YOUR-WORKER.workers.dev/api/v1/items
```

The first request should return `200`. The unauthenticated API request should return `401`.

## Attach `api.stensibly.com`

Cloudflare Worker Custom Domains require `stensibly.com` to be an active Cloudflare zone. After the Worker is healthy:

1. Open **Workers & Pages** in Cloudflare.
2. Select **stensibly-api**.
3. Open **Domains & Routes**.
4. Add the Custom Domain `api.stensibly.com`.

Cloudflare creates the DNS record and certificate. Do not keep another CNAME record on `api.stensibly.com` while attaching the Worker.

After the custom domain works, add it to `STENSIBLY_ALLOWED_ORIGINS` only if a browser application will itself be served from that origin. The API hostname does not need to be in the CORS allowlist merely because it hosts the API.

## Vercel cleanup

Keep the `stensibly-api` Vercel project until the Worker passes health, authenticated REST, MCP initialization, and CORS checks. Afterwards, disconnect its Git integration or delete the project to stop duplicate deployment attempts. The static `stensibly` Vercel project remains the dashboard host.

## Logs

Stream production Worker logs with:

```bash
bun run worker:tail
```
