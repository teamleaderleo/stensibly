# Deploy the hosted gateway to Cloudflare Workers

The `stensibly-api` Cloudflare Worker is the production gateway for Convex-backed REST v1 and remote MCP.

It is separate from:

- the static Vercel dashboard project named `stensibly`
- the Convex deployment that owns hosted state
- the local SQLite compatibility application
- the parked Vercel API project named `stensibly-api`

## Production endpoints

| Purpose | Endpoint |
| --- | --- |
| Official REST v1 and MCP | `https://api.stensibly.com` |
| Worker fallback | `https://stensibly-api.leoli-082000.workers.dev` |
| Static dashboard | `https://www.stensibly.com` |

The custom-domain Worker record should remain proxied through Cloudflare.

## Configuration checked into Git

`wrangler.jsonc` declares:

```text
Worker name: stensibly-api
Entry point: src/cloudflare-worker.ts
Workspace: default
```

The browser origin allowlist is:

```text
https://stensibly.com
https://www.stensibly.com
https://stensibly.app
https://www.stensibly.app
https://stensibly.vercel.app
```

`CONVEX_URL` and `STENSIBLY_SERVICE_SECRET` are required encrypted bindings. They never belong in `wrangler.jsonc`.

## Install and authenticate

```bash
bun install
bunx wrangler login
```

Use the Cloudflare account that owns the `stensibly-api` Worker and the `stensibly.com` zone.

## Local Worker development

Create an untracked `.dev.vars` file:

```dotenv
CONVEX_URL=https://your-convex-deployment.convex.cloud
STENSIBLY_SERVICE_SECRET=use-the-same-private-value-configured-in-convex
```

Start the Worker locally:

```bash
bun run worker:dev
```

Check the local health route:

```bash
curl http://localhost:8787/health
```

`.dev.vars`, `.env*`, `.wrangler/`, and `.wrangler-dry-run/` are ignored by Git.

## First production deployment

The first deployment must upload code and both encrypted bindings together. This avoids creating an active Worker version with missing production credentials.

Create a temporary untracked file:

```dotenv
CONVEX_URL=https://your-production-deployment.convex.cloud
STENSIBLY_SERVICE_SECRET=the-exact-secret-configured-in-convex-production
```

Save it as `.env.production`, then deploy:

```bash
bunx wrangler deploy --secrets-file .env.production
rm .env.production
```

Delete the temporary file immediately after the successful deployment. Keep one matching service-secret value in Convex and Cloudflare; creating an unrelated second value breaks gateway calls.

## Code-only deployments

Once the encrypted bindings exist, routine code deployments preserve them:

```bash
bun run worker:deploy
```

Before deployment, run:

```bash
bun run typecheck
bun test
bun run test:convex
bun run worker:check
```

`worker:check` performs a dry-run bundle and writes ignored output under `.wrangler-dry-run/`.

## Attach the custom domain

Cloudflare Worker Custom Domains require `stensibly.com` to be an active Cloudflare zone.

1. Open **Workers & Pages**.
2. Select **stensibly-api**.
3. Open **Domains & Routes**.
4. Add the Custom Domain `api.stensibly.com`.

Cloudflare creates the DNS record and certificate. Avoid a second manual CNAME on the same hostname.

The API hostname itself does not need to appear in the browser CORS allowlist. Add origins where browser applications are served.

## Verify after deployment

Use a read-only API token through the environment:

```bash
STENSIBLY_TOKEN="$STENSIBLY_TOKEN" bun run verify:hosted
```

Expected output contains five passing checks:

```text
[PASS] health
[PASS] unauthenticated REST
[PASS] REST CORS preflight
[PASS] authenticated REST
[PASS] remote MCP initialize
```

Verify the fallback independently when custom-domain diagnosis is needed:

```bash
STENSIBLY_TOKEN="$STENSIBLY_TOKEN" \
  bun run verify:hosted -- \
  --endpoint https://stensibly-api.leoli-082000.workers.dev
```

The official endpoint should remain the public configuration after both pass.

## Logs

Stream production Worker logs with:

```bash
bun run worker:tail
```

During an incident, identify which layer failed:

- `GET /health` failure: Worker route, Worker runtime, or Convex gateway setup
- unauthenticated request returns something other than `401`: route or authentication regression
- CORS failure: origin allowlist or preflight handling
- authenticated REST failure: token, scope, Worker-to-Convex call, or Convex state
- MCP initialize failure: MCP route, protocol handling, origin, or authentication

Avoid logging Authorization headers, raw tokens, or the service secret.

## Rollback

Cloudflare Worker versions can be rolled back from the dashboard or with Wrangler. A rollback creates a new deployment pointing at the selected earlier Worker version and activates it across Worker routes and custom domains.

Interactive rollback to the previous version:

```bash
bunx wrangler rollback
```

Rollback to a known version ID:

```bash
bunx wrangler rollback VERSION_ID
```

After rollback, run the hosted verifier against both the Worker fallback and official custom domain.

A Worker rollback changes Worker code and bindings captured in that version. It does not reverse Convex data changes. Coordinate any data recovery separately.

## Parked Vercel API project

The old Vercel project named `stensibly-api` no longer serves the production API. The static project named `stensibly` remains the dashboard host.

Retire the parked API project after a confidence period in which:

- the official and fallback Worker endpoints pass the hosted verifier
- routine Worker deploy and rollback have been exercised
- required logs are available
- no client configuration points at the old Vercel API deployment

Disconnecting its Git integration first stops duplicate builds while preserving an easy recovery window. Delete the project later when that recovery value is gone.

## Local Stash and fake-IP DNS caveat

One development Mac runs Stash continuously with fake-IP DNS through a remote proxy path. On that machine, ordinary local resolution of `api.stensibly.com` may fail while public DNS, TLS, direct HTTP checks, and Worker routing remain healthy.

Use the `workers.dev` fallback for local diagnosis. Avoid recreating the Worker, custom domain, or Cloudflare DNS record in response to that local resolver behavior.
