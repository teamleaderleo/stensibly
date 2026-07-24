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

### API tokens

Read or write API tokens are used by dashboards, agents, scripts, services, and the hosted verifier.

- format: `stn.tok_...`
- sent as Bearer credentials
- stored as hashes in the selected token authority
- may carry workspace, project, and action scopes

### Service secret

`STENSIBLY_SERVICE_SECRET` authorizes trusted Worker and operator calls to Convex.

- configured in Convex and as an encrypted Cloudflare binding
- separate from API tokens
- never supplied to browsers or MCP clients
- absent from the production deployment workflow

### Convex URL

`CONVEX_URL` identifies the Convex deployment for the Worker and trusted operator commands. It is stored as an encrypted Worker binding in the current deployment setup.

Keep credentials out of issue comments, pull requests, repository files, command output pasted into chat, and static host variables exposed to browser code.

## Known-good baseline

The production path has previously demonstrated:

- `/health` returns `200` and reports the Convex backend
- unauthenticated `/api/v1/items` returns `401`
- authenticated `/api/v1/items` returns `200`
- dashboard CORS preflight succeeds
- `api.stensibly.com` has public DNS, TLS, and Worker routing
- the static dashboard connects with a read-only token

Remote MCP is exposed at `/mcp`. Record a production `5/5` verifier result in issue #24 after an operator runs it with a current read token.

## Routine verification

Verify the official endpoint:

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

For a project-scoped check:

```bash
STENSIBLY_TOKEN="$STENSIBLY_TOKEN" \
  bun run verify:hosted -- --project PROJECT_SLUG
```

The verifier runs every check, redacts token-shaped values, and exits nonzero on failure. Response-based failures include the Worker request ID when available, which can be matched against production logs.

## Worker deployment

The preferred production path is the manual GitHub Actions workflow named **Deploy Worker Production**. It accepts dispatches from `main`, validates the candidate without production secrets, waits for the `production` environment approval, deploys one Worker version, and verifies both production endpoints.

### One-time GitHub setup

Create a repository environment named `production` and configure:

- required reviewers for production approval
- deployment branch protection limited to `main`
- `CLOUDFLARE_ACCOUNT_ID` as an environment secret
- `CLOUDFLARE_API_TOKEN` as an environment secret
- `STENSIBLY_READ_TOKEN` as an environment secret

Use a least-privilege Cloudflare API token scoped to the account and Worker deployment permissions required for `stensibly-api`.

`STENSIBLY_READ_TOKEN` should carry read scope. A project-scoped token works with the matching optional project input. An all-projects read token can verify without that input.

The workflow never receives `STENSIBLY_SERVICE_SECRET` or `CONVEX_URL`. Existing encrypted Worker bindings remain attached during its code-only deployment.

### Deploy through GitHub Actions

1. Open **Actions** in the repository.
2. Select **Deploy Worker Production**.
3. Choose **Run workflow** from `main`.
4. Optionally enter a lowercase project slug for a project-scoped verifier token.
5. Wait for the candidate-validation job to pass.
6. Approve the `production` environment deployment when GitHub requests approval.

The workflow performs these stages:

1. confirms the selected ref is `main`
2. installs the committed Bun lockfile in a secret-free job
3. runs typecheck, Bun tests, Convex tests, and the Worker dry-run bundle
4. requests production environment approval
5. installs locked dependencies in the deployment job
6. validates the required environment secrets and optional project slug
7. deploys with the locked Wrangler dependency
8. verifies the `workers.dev` fallback up to three times
9. verifies `api.stensibly.com` up to three times
10. records the deployed commit and successful endpoint checks in the job summary

Production secrets become available only in the deployment job after candidate checks pass and environment approval is granted.

Verifier failures include request IDs when the deployed Worker responds. Use those IDs with `bun run worker:tail` to find matching completion records.

The workflow stops after a failed post-deploy verification. It leaves rollback to an operator because Worker rollback and any Convex data implications require an explicit decision.

### Manual deployment fallback

Use the trusted-shell path when GitHub Actions is unavailable or while repairing its environment configuration.

Run the candidate checks:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:convex
bun run worker:check
```

Review changes to bindings, browser origins, authentication, scopes, REST contracts, MCP behavior, and logging before deploying.

Deploy code:

```bash
bun run worker:deploy
```

Verify both endpoints:

```bash
STENSIBLY_TOKEN="$STENSIBLY_TOKEN" bun run verify:hosted

STENSIBLY_TOKEN="$STENSIBLY_TOKEN" \
  bun run verify:hosted -- \
  --endpoint https://stensibly-api.leoli-082000.workers.dev
```

A custom-domain failure with a healthy fallback points toward DNS, TLS, or route attachment. Failure on both points toward Worker code, bindings, or Convex.

## Dashboard deployment

The dashboard is the static Vercel project named `stensibly`. Its production branch is deployed through Vercel Git integration.

Before merging dashboard changes, confirm:

- CSP remains restrictive
- API calls use `/api/v1`
- the token stays in `sessionStorage`
- the endpoint alone enters `localStorage`
- credentials stay out of HTML, JavaScript, Vercel variables, URLs, and analytics
- connection, change, cancel, disconnect, refresh, and expired-token behavior work

After production deployment:

1. open a clean browser profile
2. connect with a read-only token
3. confirm the compact state shows the endpoint and never the token
4. refresh and confirm same-session reconnection
5. disconnect and confirm the token is cleared
6. run the hosted verifier separately

A dedicated dashboard deployment workflow remains future automation work.

## Logs

Stream Worker logs:

```bash
bun run worker:tail
```

Every Worker response carries `X-Request-ID`. Allowed dashboard origins can read that header through CORS.

Each completed request emits one JSON record containing:

- event name
- request ID
- method
- route class: `health`, `rest_v1`, `mcp`, or `other`
- response status
- duration in milliseconds
- success or failure outcome
- failure category when applicable

Failure categories include authentication, authorization, CORS, Convex, MCP, request, and gateway failures.

Completion records exclude URLs, query strings, item IDs, project names, request headers, request bodies, raw tokens, token IDs, token hashes, service secrets, and private artifact content.

When the verifier reports `requestId=...`, search the Worker tail output for the same value.

## Incident diagnosis

### Health fails on official and fallback endpoints

Inspect Worker logs and encrypted bindings. Confirm the Worker is deployed and the `CONVEX_URL` and `STENSIBLY_SERVICE_SECRET` bindings are present. Check Convex availability and service-secret agreement.

### Health passes; unauthenticated REST misses its `401` result

Treat this as an authentication regression or route mismatch. Inspect recent gateway and middleware changes before testing writes.

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

The token is malformed, revoked, unknown to the active token authority, or belongs to another environment. Create or select a current read token through a trusted operator path.

### Authenticated REST returns `403`

The token lacks read scope, workspace access, or project access, or the browser origin is forbidden. Read the API response and inspect token metadata from a trusted operator environment.

### Authenticated REST returns `404`

Confirm the endpoint is a Stensibly gateway and the client uses `/api/v1/items`. A legacy or unrelated deployment may answer on the hostname without exposing REST v1.

### REST passes; MCP fails

Inspect `/mcp` routing, Bearer authentication, the MCP protocol version, host restrictions, and origin restrictions. The verifier sends a real Streamable HTTP `initialize` request.

### Official endpoint fails; Worker fallback passes

Inspect the `api.stensibly.com` Worker Custom Domain, proxied DNS record, certificate, and route attachment. Preserve the healthy Worker.

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

Use the Vercel project deployment history to select Instant Rollback. With the Vercel CLI installed and linked to the `stensibly` project:

```bash
vercel rollback
vercel rollback status
```

After recovery, verify the production domain in a clean browser.

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

Save the raw token once and deliver it through an appropriate secret channel. Revoke hosted tokens by ID with the same Convex environment:

```bash
STENSIBLY_BACKEND=convex \
CONVEX_URL="$CONVEX_URL" \
STENSIBLY_SERVICE_SECRET="$STENSIBLY_SERVICE_SECRET" \
STENSIBLY_WORKSPACE=default \
  bun run tokens revoke tok_TOKEN_ID
```

## Service-secret rotation

The current design expects one matching secret in the Worker and Convex deployment. Rotate it as a coordinated maintenance action:

1. prepare a new high-entropy value in a trusted environment
2. update Convex and the encrypted Worker binding in one controlled window
3. redeploy or activate the Worker binding
4. run the hosted verifier
5. remove temporary local copies

A dual-secret overlap mechanism would enable a smoother future rotation and belongs in the hosted security roadmap.

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
