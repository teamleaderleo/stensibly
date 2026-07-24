# Convex backend

Convex is the hosted system of record for Stensibly coordination state and hosted API-token authority.

The original SQLite implementation remains available for local compatibility. The Cloudflare Worker, REST v1, remote MCP, and public dashboard use the Convex-backed path in production.

## Hosted request path

```text
Dashboard, agents, scripts, and services
                    |
             Bearer API token
                    |
          Cloudflare Worker gateway
             /api/v1 and /mcp
                    |
       STENSIBLY_SERVICE_SECRET
                    |
                  Convex
```

The Worker authenticates the public token, enforces workspace and project access, and invokes Convex with the private service secret. Convex never receives the raw public token secret; the gateway sends its token ID and SHA-256 secret digest for authentication.

## Current Convex domain

The schema includes:

- workspaces
- projects
- actors
- work items
- append-only events
- artifact references
- agent runs
- item dependencies
- resource reservations
- API-token records

The hosted ledger supports:

- deterministic project briefs
- item creation and detail
- renewable claims with expiring leases
- handoff, block, unblock, release, and completion
- append-only progress and coordination events
- artifact attachment and listing
- dependencies
- agent-run visibility in the data model
- resource reservations
- scoped, hashed, revocable API tokens
- idempotent writes

## Claims and reservations

Work claims and resource reservations are separate concepts.

A claim says an actor is responsible for driving an item. A reservation protects a scarce resource such as a staging environment, test account, migration window, or capacity pool.

Both use a generation-guarded expiry model:

1. Creation schedules an expiry for generation `N`.
2. Renewal increments the generation and schedules a new expiry.
3. An older scheduled function sees the generation mismatch and exits.
4. The latest expiry releases the claim or reservation and appends the appropriate event.
5. Ownership-sensitive mutations also recover already-expired state when a scheduled function is delayed.

This prevents an obsolete timer from releasing a renewed lease.

## Authentication boundary

`STENSIBLY_SERVICE_SECRET` is a server-to-server credential for trusted Worker and operator calls into Convex.

It belongs only in:

- the Convex deployment environment
- encrypted Cloudflare Worker secrets
- a trusted operator shell for token administration or migration

It never belongs in:

- the public dashboard
- static Vercel environment variables exposed to browser code
- an MCP client
- an API `Authorization` header
- logs, issue bodies, or repository files

Public clients use opaque `stn.tok_...` API tokens. Token records store hashes, scopes, workspace ownership, optional project allowlists, and revocation state.

## Test without a Convex account

Install dependencies and run both suites:

```bash
bun install
bun test
bun run test:convex
```

The Convex suite uses `convex-test` in memory. It covers competing claims, idempotent commands, scheduled lease expiry, obsolete-timer races, artifacts, handoffs, dependencies, runs, reservations, token lifecycle, and project briefs.

## Run Convex locally

Convex can run locally without selecting a cloud project:

```bash
bun run convex:local
```

Keep that process running. Local deployment state is written under `.convex/` and ignored by Git. The Convex CLI selects the local deployment and writes its connection information to the local environment file.

In a second trusted shell, create one private value and configure the same value in the local Convex deployment and Bun gateway:

```bash
export STENSIBLY_SERVICE_SECRET="$(openssl rand -hex 32)"
bunx convex env set STENSIBLY_SERVICE_SECRET "$STENSIBLY_SERVICE_SECRET"

export STENSIBLY_BACKEND=convex
export CONVEX_URL=<the-CONVEX_URL-written-or-printed-by-the-Convex-CLI>
export STENSIBLY_WORKSPACE=default
bun run start
```

The local Convex process must remain active while the gateway uses it. Keep the generated secret and local environment files untracked.

## Hosted migration status

Completed:

- Convex domain and tests
- server-only Convex ledger client
- REST `/api/v1` operations on Convex
- remote MCP tools on the same ledger interface
- Convex-backed API-token authority
- Cloudflare Worker production gateway
- SQLite-free Worker bundle
- static dashboard reads from hosted REST v1
- versioned SQLite snapshot export and staged Convex import
- hosted smoke verifier

Remaining product and operations work:

- decide whether useful local SQLite data should enter production
- define retention and archival rules
- exercise backup and recovery against production-like data
- expand the dashboard from read-only inspection to one complete write workflow
- decide the longer-term browser authentication and workspace tenancy model

The dashboard currently polls REST v1. Reactive Convex queries exist as a backend capability; the browser has no direct Convex connection.

## Durable boundary

External systems own code, CI results, files, deployments, and private execution trees.

Convex stores coordination facts: what work exists, who is responsible, what is blocked, which resources are reserved, what evidence came back, and what should happen next.
