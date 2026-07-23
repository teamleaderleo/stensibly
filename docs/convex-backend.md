# Convex backend

Stensibly is moving its canonical shared state from the original SQLite prototype into Convex.

The SQLite service remains available while the public REST and MCP gateways are adapted. New coordination behavior belongs in Convex first.

## Why Convex fits

The ledger needs transactional state changes, live project views, durable timers, and eventually event-driven dispatch. Convex provides those primitives in one backend:

- serializable mutations for claims and transitions
- reactive queries for boards and briefs
- durable scheduled functions for lease expiry
- actions and workflows for external agent launches later
- local and cloud development paths

## Current Convex domain

The schema includes:

- workspaces
- projects
- actors
- items
- append-only events
- artifact references
- agent runs
- item dependencies
- resource reservations

Work claims and resource reservations are deliberately separate.

A claim means an actor is responsible for driving an item. A reservation protects a scarce resource such as a staging environment, test account, migration window, or capacity pool.

## Authentication boundary

Convex functions currently require `STENSIBLY_SERVICE_SECRET`. This is a server-to-server credential for Stensibly's REST and MCP gateways. It must never be sent to the public dashboard or an untrusted agent client.

The existing Stensibly API tokens remain the public credential model. The gateway authenticates those tokens, applies workspace/project scopes, and invokes Convex with its private service secret.

## Test without a Convex account

Install dependencies and run both suites:

```bash
bun install
bun test
bun run test:convex
```

The Convex suite uses `convex-test` in memory. It covers competing claims, idempotent commands, scheduled lease expiry, obsolete-timer races, artifacts, handoffs, dependencies, runs, reservations, and project briefs.

## Run a local Convex backend

Convex can run locally without selecting a cloud project:

```bash
bun run convex:local
```

Local deployment state is written under `.convex/` and is ignored by Git.

Set a private service secret for manual calls:

```bash
export STENSIBLY_SERVICE_SECRET="replace-this-with-a-long-random-value"
```

## Cloud setup blocker

A real Convex account/project is needed only when the gateway or public dashboard is ready to connect to a persistent deployment.

At that point:

```bash
bun run convex:dev
```

Select or create a project named `stensibly`, then configure the same `STENSIBLY_SERVICE_SECRET` in the Convex deployment and the server-side Vercel environment.

Do not expose that secret through a `VITE_`, `NEXT_PUBLIC_`, or other browser-visible environment variable.

## Lease model

Each claim has a monotonically increasing generation.

1. Claiming schedules an expiry for generation `N`.
2. Renewal increments the generation and schedules a new expiry.
3. An old scheduled function sees the generation mismatch and exits.
4. The latest expiry releases the claim and appends `claim.expired`.
5. Ownership-sensitive mutations also recover an already-expired claim in case a scheduled function is delayed.

Resource reservations use the same generation pattern.

## Migration sequence

1. Land and test the Convex domain.
2. Add a server-only Convex gateway client.
3. Port REST `/api/v1` operations to Convex.
4. Port MCP tools to the same gateway operations.
5. Switch the dashboard from polling the SQLite service to reactive Convex-backed views.
6. Add an export/import command for useful SQLite data.
7. Remove SQLite from the hosted path after compatibility tests pass.
8. Keep the old SQLite implementation available in history and releases for small self-hosted experiments until the Convex local deployment path is comfortable enough.

## Durable rule

External systems still own code, CI results, files, deployments, and private agent execution trees.

Convex stores the coordination facts: what work exists, who is responsible, what is blocked, which resources are reserved, what evidence came back, and what should happen next.
