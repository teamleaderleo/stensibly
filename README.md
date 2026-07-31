# Stensibly

**A responsibility and authority ledger for human-agent work.**

Stensibly records shared coordination facts: what needs doing, who is responsible, what is blocked, what evidence exists, and what happens next. The server owns this shared state. Agent frameworks remain optional clients.

The collaborative board is the simplest projection of that state. The broader product governs which actor may perform which work, under which current authority grant, with which obligations, resources, limits, and escalation rules.

> **The board shows the work. The ledger governs who may do it.**

See [the product model](docs/product-model.md) for the distinction between a collaborative task board, a responsibility ledger, and a governed execution control plane.

External systems continue to own source code, files, deployments, CI output, and private agent execution. Stensibly stores references and coordination history instead of copying those systems into the ledger.

## Hosted service

The running hosted path is:

| Surface | Endpoint | Role |
| --- | --- | --- |
| Dashboard | `https://www.stensibly.com` | Static browser board and item-detail client |
| REST v1 and remote MCP | `https://api.stensibly.com` | Official authenticated API |
| Worker fallback | `https://stensibly-api.leoli-082000.workers.dev` | Direct Worker endpoint during rollout and diagnosis |
| System of record | Convex | Workspaces, projects, actors, items, events, artifacts, runs, dependencies, reservations, accounts, sessions, and API-token hashes |

The Cloudflare Worker authenticates public API tokens and hosted browser sessions, enforces workspace and project scopes, and calls Convex with a private service secret. The browser never receives that service secret.

The dashboard currently polls REST v1. Manual endpoint and token connection remains available for self-hosted use and diagnostics. The token is kept in `sessionStorage`, disappears when the browser session ends, and is never rendered after connection.

### Verify the hosted path

Use a read token through the environment so it stays out of shell history:

```bash
STENSIBLY_TOKEN="$STENSIBLY_TOKEN" bun run verify:hosted
```

The verifier performs five read-only checks:

1. Convex-backed health
2. unauthenticated REST rejection
3. dashboard CORS preflight
4. authenticated item listing
5. authenticated remote MCP initialization

Use the Worker fallback or a project-scoped check when needed:

```bash
STENSIBLY_TOKEN="$STENSIBLY_TOKEN" \
  bun run verify:hosted -- \
  --endpoint https://stensibly-api.leoli-082000.workers.dev \
  --project scrapbook
```

See [docs/operations.md](docs/operations.md) for deployment, verification, logs, rollback, and incident diagnosis.

## Two supported modes

### Hosted Convex mode

This is the production path. Convex owns shared state and authentication authority. Cloudflare Workers exposes REST v1 and Streamable HTTP MCP. The static Vercel site is a client of that API.

Hosted clients should use:

- `/api/v1` for REST
- `/mcp` for remote MCP
- Bearer authentication for machine clients and advanced browser connection
- the hosted browser session for supported human REST access

MCP remains bearer-only.

### Local SQLite compatibility mode

The original Bun and SQLite application remains useful for local experiments and small self-hosted setups. It includes the browser board, REST v1, legacy unversioned `/api` routes, local token authority, and remote MCP.

The unversioned `/api` routes are compatibility routes. New clients should use `/api/v1` in both modes.

## Run locally with SQLite

Install [Bun](https://bun.sh), then:

```bash
bun install
bun run dev
```

Open `http://localhost:3000`. The default database is `./stensibly.sqlite`.

Choose another database path with:

```bash
STENSIBLY_DB=/absolute/path/to/stensibly.sqlite bun run start
```

Local HTTP authentication is disabled by default. Enable it before exposing the process beyond a trusted machine.

Create a local token:

```bash
STENSIBLY_DB=/absolute/path/to/stensibly.sqlite \
  bun run tokens create \
  --name local-agent \
  --scopes read,write \
  --projects scrapbook
```

Start the local server with authentication required:

```bash
STENSIBLY_DB=/absolute/path/to/stensibly.sqlite \
STENSIBLY_REQUIRE_AUTH=true \
  bun run start
```

The token command prints the raw token once. Stensibly stores its SHA-256 hash, metadata, scopes, project allowlist, and revocation state.

## REST v1

Set the endpoint and token for examples:

```bash
export STENSIBLY_ENDPOINT=https://api.stensibly.com
export STENSIBLY_TOKEN=stn.tok_...
```

List work:

```bash
curl "$STENSIBLY_ENDPOINT/api/v1/items?project=scrapbook&status=ready" \
  -H "authorization: Bearer $STENSIBLY_TOKEN"
```

Get a deterministic project brief:

```bash
curl "$STENSIBLY_ENDPOINT/api/v1/projects/scrapbook/brief?limit=10" \
  -H "authorization: Bearer $STENSIBLY_TOKEN"
```

Create an item with a write token:

```bash
curl "$STENSIBLY_ENDPOINT/api/v1/items" \
  -H "authorization: Bearer $STENSIBLY_TOKEN" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-create-1' \
  -d '{
    "project": "scrapbook",
    "kind": "task",
    "title": "See whether this thing works",
    "nextAction": "Claim it from another process",
    "actor": { "id": "leo", "name": "Leo", "kind": "human" }
  }'
```

REST v1 supports project briefs, item listing and detail, creation, artifacts, claims, renewal, handoff, block, unblock, release, completion, and append-only event recording. Retryable clients should supply idempotency keys for writes.

## MCP

### Remote Streamable HTTP

The hosted MCP endpoint is:

```text
https://api.stensibly.com/mcp
```

Remote MCP requires Bearer authentication. It exposes the same ledger operations as REST v1 and applies the same token scopes and project boundaries.

Available tools include:

- `get_brief`
- `list_work`
- `get_item`
- `create_item`
- `claim_work`
- `renew_claim`
- `handoff_work`
- `block_work`
- `unblock_work`
- `release_work`
- `record_event`
- `attach_artifact`
- `list_artifacts`
- `complete_work`

### Local stdio

For a trusted local client:

```bash
STENSIBLY_DB=/absolute/path/to/stensibly.sqlite bun run mcp
```

The stdio process uses the local SQLite database directly and does not use HTTP Bearer authentication.

## Token administration

Token records contain hashes instead of raw secrets. List or revoke token metadata with:

```bash
bun run tokens list
bun run tokens revoke tok_TOKEN_ID
```

To administer hosted Convex tokens, configure a trusted operator shell before running those commands:

```bash
export STENSIBLY_BACKEND=convex
export CONVEX_URL=https://your-deployment.convex.cloud
export STENSIBLY_SERVICE_SECRET=...
export STENSIBLY_WORKSPACE=default
```

`STENSIBLY_SERVICE_SECRET` is a Worker/CLI-to-Convex credential. It is never an API bearer token and never belongs in the dashboard, a static host variable, a URL, or a client configuration.

## Core rules

1. Work belongs to a workspace and project, independent of any agent runtime.
2. The board is a projection; server-owned ledger state remains authoritative.
3. Assignment does not by itself grant permission to act.
4. Claims and run leases are renewable, expiring authority grants.
5. Stale or superseded authority must fail closed rather than fall back to actor identity.
6. Responsibility survives process and conversation loss through durable next actions, evidence, events, outcomes, blockers, and handoffs.
7. Handoffs carry a summary and an explicit next action.
8. Blocking work records a reason and releases ownership.
9. Meaningful changes append events.
10. Artifacts remain references with explicit provenance.
11. API tokens store hashed secrets and carry explicit scopes.
12. Workspace and project boundaries are enforced by the server.
13. Writes support idempotency keys; idempotency does not replace authority fencing.
14. Invariant reconciliation and semantic project decisions are separate policy classes.
15. The server performs no model calls.

## Development checks

```bash
bun install
bun run typecheck
bun test
bun run test:convex
bun run worker:check
```

The Convex test suite runs in memory and covers competing claims, idempotent commands, scheduled lease expiry, timer races, artifacts, handoffs, dependencies, runs, reservations, tokens, sessions, and project briefs.

## Current product boundary

The hosted coordination foundation is live: Convex state, API-token and browser-session authentication, Cloudflare Worker, REST v1, remote MCP, custom API domain, and static dashboard.

The dashboard can inspect shared item state, history, dependencies, reservation capacity, and recent agent runs. The ledger contains early dispatcher, continuation, reservation, run-lifecycle, reconciliation, and authority-fencing mechanics.

Stensibly is ready for a guarded single-project pilot as a durable coordination system. It is not yet ready for unattended, multi-project autonomy or irreversible external effects.

The next product work should prove the authority-and-responsibility distinction in execution:

1. complete end-to-end claim and run fencing;
2. make current authority, outstanding responsibility, and approval state legible;
3. dogfood one real project with one supervisor and one runner at concurrency one;
4. add durable command inbox/outbox semantics before unattended retries;
5. add one production-quality runner adapter and a bounded long-lived supervisor;
6. keep merges, deployments, messages, provider changes, spending, and other consequential effects behind durable human approval until workflow and compensation semantics exist.

See [issue #214](https://github.com/teamleaderleo/stensibly/issues/214) for the guarded pilot boundary.

## Documentation

- [Engineering handbook](docs/engineering-handbook.md)
- [Current-main code atlas](docs/code-atlas.md)
- [Product model: authority and responsibility](docs/product-model.md)
- [Agent and work-group nomenclature](docs/agent-nomenclature.md)
- [Distributed coordination correctness](docs/coordination-correctness.md)
- [Architecture](docs/architecture.md)
- [Hosted operations](docs/operations.md)
- [Cloudflare deployment](docs/cloudflare-deployment.md)
- [Convex backend](docs/convex-backend.md)

## License

Apache-2.0.