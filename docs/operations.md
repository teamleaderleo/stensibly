# Hosted operations

This guide covers routine operation of the hosted Stensibly path after the first Convex and Cloudflare setup is complete.

First-time Worker setup and custom-domain attachment live in [cloudflare-deployment.md](cloudflare-deployment.md). Component and trust-boundary details live in [architecture.md](architecture.md).

## Production inventory

| Component | Production value |
| --- | --- |
| Dashboard | `https://www.stensibly.com` |
| Official API and MCP | `https://api.stensibly.com` |
| Worker fallback | `https://stensibly-api.leoli-082000.workers.dev` |
| Worker name | `stensibly-api` |
| Vercel dashboard project | `stensibly` |
| Hosted backend | Convex |
| Default workspace | `default` |

The Vercel project named `stensibly-api` is a parked legacy API deployment. It is outside the active request path.

## Credential inventory

### Read or write API token

Used by dashboards, agents, scripts, services, and the hosted verifier.

- format: `stn.tok_...`
- sent as a Bearer credential
- stored as a hash in the selected token authority
- may carry workspace, project, and action scopes

### Service secret

Used by the Worker and trusted operator commands to call Convex.

- environment name: `STENSIBLY_SERVICE_SECRET`
- configured in Convex and as an encrypted Cloudflare binding
- separate from API tokens
- never supplied to browser or MCP clients

### Convex URL

Used by the Worker and trusted operator commands.

- environment name: `CONVEX_URL`
- stored as an encrypted Worker binding in the current deployment setup

Avoid placing any credential in issue comments, pull requests, repository files, command output pasted into chat, or static host variables exposed to the browser.

## Known-good baseline

The production path has previously demonstrated:

- `/health` returns `200` and reports the Convex backend
- unauthenticated `/api/v1/items` returns `401`
- authenticated `/api/v1/items` returns `200`
- dashboard CORS preflight succeeds
- remote MCP initializes with Bearer authentication
- `api.stensibly.com` has public DNS, TLS, and Worker routing
- the static dashboard connects with a read-only token

Use the verifier to establish the current state instead of repeating manual tests one layer at a time.

## Routine verification

```bash
STENSIBLY_TOKEN="$STENSIBLY_TOKEN" bun run verify:hosted
```

Expected summary:

```text
5/5 hosted checks passed
```

Verify the Worker fallback independently:

```bash
STENSIBLY_TOKEN="$STENSIBLY_TOKEN" \
  bun run verify:hosted -- \
  --endpoint https://stensibly-api.leoli-082000.workers.dev
```

For a project-scoped token:

```bash
STENSIBLY_TOKEN="$STENSIBLY_TOKEN" \
  bun run verify:hosted -- --project PROJECT_SLUG
```

The verifier redacts token-shaped values, runs every check, and exits nonzero when any check fails.

## Worker deployment

### Before deployment

```bash
bun install
bun run typecheck
bun test
bun run test:convex
bun run worker:check
```

Review the proposed changes for:

- new environment bindings
- changes to `STENSIBLY_ALLOWED_ORIGINS`
- authentication or scope behavior
- REST response contracts
- MCP protocol behavior
- raw token or secret logging

### Deploy code

```bash
bun run worker:deploy
```

Existing encrypted bindings remain attached during a code-only deployment.

### Verify immediately

```bash
STENSIBLY_TOKEN="$STENSIBLY_TOKEN" bun run verify:hosted
```

Then verify the fallback endpoint. A custom-domain failure with a healthy fallback points toward DNS, TLS, or route attachment. Failure on both points toward Worker code, bindings, or Convex.

## Dashboard deployment

The dashboard is the static Vercel project named `stensibly`. Its production branch is deployed through Vercel Git integration.

Before merging dashboard changes:

- confirm CSP remains restrictive
- confirm API calls use `/api/v1`
- confirm the token stays in `sessionStorage`
- confirm the endpoint alone enters `localStorage`
- confirm no credential appears in HTML, JavaScript, Vercel variables, URLs, or analytics
- test connection, change, cancel, disconnect, refresh, and expired-token behavior

After the production deployment:

1. Open a clean browser profile.
2. Connect with a read-only token.
3. Confirm the compact connected state shows the endpoint and never the token.
4. Refresh the page and confirm same-session reconnection.
5. Disconnect and confirm the token is cleared.
6. Run the hosted verifier separately to confirm the API path.

A dedicated dashboard deployment script or workflow remains future automation work.

## Logs

Stream Worker logs:

```bash
bun run worker:tail
```

Useful log categories should include:

- request ID
- route and method
- authentication failure category
- CORS rejection
- Convex call failure
- response status

Logs should exclude:

- `Authorization` headers
- raw API tokens
- token hashes
- `STENSIBLY_SERVICE_SECRET`
- private artifact contents

Request IDs and categorized failures remain a product backlog item where the current logs lack them.

## Incident diagnosis

### Health fails on official and fallback endpoints

Inspect Worker logs and encrypted bindings. Confirm the Worker is deployed and `CONVEX_URL` plus `STENSIBLY_SERVICE_SECRET` are present. Check Convex availability and service-secret agreement.

### Health passes; unauthenticated REST fails its `401` check

Treat this as an authentication regression or route mismatch. Inspect recent gateway and middleware changes before testing write behavior.

### CORS preflight fails

Compare the requesting browser origin with `STENSIBLY_ALLOWED_ORIGINS` in `wrangler.jsonc`.

Current expected origins:

```text
https://stensibly.com
https://www.stensibly.com
https://stensibly.app
https://www.stensibly.app
https://stensibly.vercel.app
```

Redeploy the Worker after changing the allowlist.

### Authenticated REST returns `401`

The token is malformed, revoked, unknown to the active token authority, or signed for another environment. Create or select a current read token. Keep the raw value out of logs and issue comments.

### Authenticated REST returns `403`

The token lacks read scope, workspace access, project access, or the browser origin is forbidden. Read the API error and check the token metadata from a trusted operator environment.

### Authenticated REST returns `404`

Confirm the endpoint is a Stensibly gateway and the client uses `/api/v1/items`. A legacy or unrelated deployment may answer on the hostname without exposing REST v1.

### REST passes; MCP fails

Inspect `/mcp` routing, Bearer authentication, the MCP protocol version, host restrictions, and origin restrictions. The verifier sends a real Streamable HTTP `initialize` request.

### Official endpoint fails; Worker fallback passes

Inspect the `api.stensibly.com` Worker Custom Domain, proxied DNS record, certificate, and route attachment. Preserve the healthy Worker and avoid recreating it as a first response.

### Dashboard fails; verifier passes

Focus on browser state, CSP, CORS, extensions, cached static assets, and the Vercel deployment. Test in a clean browser profile.

## Rollback

### Worker

Roll back interactively to the previous Worker version:

```bash
bunx wrangler rollback
```

Or select a known version:

```bash
bunx wrangler rollback VERSION_ID
```

Run the hosted verifier against the fallback and official endpoints immediately afterward.

Worker rollback does not reverse Convex records. Evaluate data recovery separately when an incident included writes or migrations.

### Dashboard

Use the Vercel project deployment history or the CLI to return production traffic to the previous deployment:

```bash
vercel rollback
vercel rollback status
```

After recovery, verify the production domain in a clean browser. Promoting a corrected deployment restores the normal production assignment flow.

## Token operations

List hosted token metadata from a trusted environment:

```bash
STENSIBLY_BACKEND=convex \
CONVEX_URL="$CONVEX_URL" \
STENSIBLY_SERVICE_SECRET="$STENSIBLY_SERVICE_SECRET" \
STENSIBLY_WORKSPACE=default \
  bun run tokens list
```

Create a project-scoped read token:

```bash
STENSIBLY_BACKEND=convex \
CONVEX_URL="$CONVEX_URL" \
STENSIBLY_SERVICE_SECRET="$STENSIBLY_SERVICE_SECRET" \
STENSIBLY_WORKSPACE=default \
  bun run tokens create \
  --name dashboard-reader \
  --scopes read \
  --projects PROJECT_SLUG
```

Save the raw token once, then deliver it through an appropriate secret channel. Revoke compromised or obsolete tokens by ID:

```bash
bun run tokens revoke tok_TOKEN_ID
```

Run the token command with the same Convex environment variables so it targets hosted authority.

## Service-secret rotation

The current design expects one matching secret in the Worker and Convex deployment. Rotate it as a coordinated maintenance action:

1. prepare the new high-entropy value in a trusted environment
2. update Convex and the encrypted Worker binding in one controlled window
3. redeploy or activate the Worker binding
4. run the hosted verifier
5. remove temporary local copies

A dual-secret overlap mechanism would make future zero-downtime rotation safer and belongs in the hosted security roadmap.

## Backup and recovery

Snapshot export and Convex import support migration from SQLite. A complete hosted backup, retention, archival, and recovery policy remains pending.

Before a hosted beta promises recovery guarantees, define and test:

- Convex backup cadence
- retention periods
- item and event archival
- token-record handling
- restore verification
- recovery time and recovery point targets

## Local Stash DNS caveat

One development Mac uses Stash fake-IP DNS through a remote proxy path. Ordinary resolution of `api.stensibly.com` may fail there while the public service remains healthy.

Diagnosis order:

1. run the verifier against the `workers.dev` fallback
2. check public DNS and TLS from an external path
3. check direct Worker logs
4. treat the Mac resolver as a local proxy issue when those layers pass

Preserve the Worker, custom domain, proxied DNS record, and user proxy settings unless evidence identifies a production fault.

## Parked Vercel API retirement

The old Vercel `stensibly-api` project may be disconnected from Git after the Worker path has a confidence period, deployment and rollback are exercised, logs are adequate, and clients use the official or fallback Worker endpoints.

The Vercel `stensibly` dashboard project remains active.
