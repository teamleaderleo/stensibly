# Architecture

Stensibly is a coordination ledger. It provides one shared record of work across humans, agents, scripts, and services while leaving execution and artifact ownership in external systems.

## Design goal

The ledger answers:

- What work exists?
- Which workspace and project own it?
- Who is responsible now?
- When does that ownership expire?
- Why is work blocked?
- What evidence or output exists?
- Which action should happen next?

It does not run models, copy repositories, store build output, or replace CI and deployment systems.

## Hosted topology

```text
                         Public clients
              humans / agents / scripts / services
                                |
                       opaque API bearer token
                                |
             +------------------+------------------+
             |                                     |
   https://www.stensibly.com          https://api.stensibly.com
       static dashboard                 Cloudflare Worker
             |                         /api/v1 and /mcp
             | polls REST v1                       |
             +--------------------------+----------+
                                        |
                             private service secret
                                        |
                                      Convex
```

The Worker fallback is `https://stensibly-api.leoli-082000.workers.dev`.

## Static dashboard

The dashboard is static HTML, CSS, and JavaScript hosted by the Vercel project named `stensibly`.

Current behavior:

- user supplies an API endpoint and read token
- endpoint is stored in `localStorage`
- token is stored in `sessionStorage`
- token is never displayed after connection
- changing the endpoint requires token re-entry
- the browser polls `GET /api/v1/items`
- the browser exposes read-only list and board views
- transient request failures preserve the last successful view and show a retry state
- invalid credentials or an incompatible API hide stale data

The dashboard bundle contains no durable bearer token and no Worker-to-Convex service secret.

## Cloudflare Worker

The Worker is the public hosted gateway.

Responsibilities:

- terminate public HTTP requests
- expose `/health`
- expose REST v1 under `/api/v1`
- expose remote Streamable HTTP MCP under `/mcp`
- enforce browser origin rules
- authenticate opaque API tokens
- enforce read, write, admin, workspace, and project boundaries
- translate requests into the shared ledger interface
- call Convex with the private service secret

The Worker performs no model calls and bundles no SQLite runtime.

## REST v1

REST v1 is the canonical hosted HTTP API.

Current resources and transitions include:

- project brief
- list items
- create item
- item detail and event history
- list and attach artifacts
- claim and renew
- handoff
- block and unblock
- release
- complete
- record event

Write clients should provide idempotency keys. Conflict and validation responses remain server decisions; browser code should reuse these contracts instead of creating parallel business rules.

The local Bun server also mounts REST v1. Its unversioned `/api` routes remain for SQLite compatibility.

## Remote MCP

Remote MCP uses Streamable HTTP at `/mcp` and Bearer authentication.

It exposes the same ledger operations through tools. Scope and project checks run before tool invocation. Read-only tokens can initialize MCP and call read tools; write tools require write or admin scope.

The server currently uses stateless JSON responses for each HTTP request. The hosted verifier performs a real authenticated `initialize` request after every deployment.

## API-token model

Public API tokens are opaque values with three parts:

```text
stn.tok_<token-id>.<secret>
```

The raw secret is shown once when created. Stored records contain:

- token ID
- SHA-256 secret hash
- name
- scopes
- workspace
- optional project allowlist
- revocation state and timestamps

The gateway parses the raw token and sends only the token ID and secret hash into Convex authentication.

Current browser access uses a user-supplied read token kept for one browser session. Browser login, intentionally public views, and a richer hosted authentication system remain future product decisions.

## Worker-to-Convex credential

`STENSIBLY_SERVICE_SECRET` authorizes trusted Worker and operator calls to Convex.

This credential has a separate purpose from API bearer tokens. It belongs only in trusted server environments. Exposure would bypass the public token boundary, so it must stay out of static bundles, browser storage, client configuration, logs, and repository files.

## Convex data model

Convex owns hosted records for:

- workspaces
- projects
- actors
- items
- events
- artifact references
- agent runs
- dependencies
- resource reservations
- API tokens

Meaningful item transitions append events. Claims and reservations use generation-guarded expiries so an obsolete timer cannot release renewed ownership.

## Local SQLite compatibility

The Bun application defaults to `STENSIBLY_BACKEND=sqlite` and stores local state in `stensibly.sqlite` or `STENSIBLY_DB`.

Local mode provides:

- a server-rendered board
- REST v1
- legacy unversioned `/api` routes
- local token authority
- remote HTTP MCP
- trusted local stdio MCP
- snapshot export for migration

The same `WorkLedger` interface backs SQLite and Convex behavior. Hosted code belongs in the shared ledger contracts and Convex implementation before browser-specific shortcuts are considered.

## Artifact boundary

Artifacts are references rather than copied content.

A reference can point to a file, URL, commit, issue, document, image, log, dataset, or another external object. Stensibly stores the URI, label, kind, provenance, optional MIME type, and metadata.

The originating system remains authoritative for access control, retention, versioning, and content.

## Trust boundaries

### Public and semi-public

- static dashboard assets
- `/health`
- public DNS and TLS metadata

### Authenticated client boundary

- REST v1
- remote MCP
- API bearer token
- workspace and project scopes

### Trusted service boundary

- Cloudflare encrypted bindings
- Convex service-secret checks
- hosted token administration
- migration and recovery commands

### External ownership boundary

- source repositories
- CI systems
- deployment platforms
- files and object stores
- private agent execution
- model providers

## Core invariants

- claims are renewable, expiring leases
- handoffs carry a summary and next action
- blocked work records a reason and releases ownership
- meaningful changes append events
- artifacts remain references
- writes support idempotency keys
- raw token secrets are never stored
- workspace and project scopes are enforced server-side
- the server performs no model calls
- external systems retain ownership of execution and artifacts

## Current product boundary

The hosted read path is complete. The dashboard currently exposes inspection, filtering, connection management, and polling.

The next interface boundary is one complete write loop: create, inspect, claim, record progress, block or unblock, and complete. Advanced dependency, reservation, handoff, artifact, and agent-run views should follow after that loop works cleanly for both humans and agents.
