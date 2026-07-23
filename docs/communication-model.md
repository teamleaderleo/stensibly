# Communication model

Stensibly is a shared work-in-progress ledger. It is not a new agent wire protocol and it is not a replacement filesystem.

The ledger has one canonical domain model and several doors:

| Door | Intended use |
| --- | --- |
| REST/JSON | scripts, dashboards, GitHub Apps, webhooks, orchestrators, and ordinary service integrations |
| MCP stdio | a local agent harness started as a child process |
| MCP Streamable HTTP | a remote agent harness using a Stensibly API token |
| A2A adapter (later) | delegation of a whole task to an independently hosted agent service |
| Web UI | human inspection and intervention |

Every door invokes the same domain operations. Protocol adapters must not invent their own task state.

## There is no Stensibly file type

The durable data is relational state plus append-only events:

- projects
- items
- actors
- claims
- artifacts
- events
- API tokens
- later: runs, dependencies, reservations, subscriptions, and workspaces

JSON schemas define request and response bodies. Export formats can be added later, but agents should not coordinate by rewriting one shared document.

A Markdown file such as `AGENTS.md` remains useful for stable instructions:

```md
This repository uses Stensibly.
Start with `get_brief`, claim tracked work before beginning, attach useful evidence, and end with completion, handoff, block, or release.
```

The changing state belongs in the ledger.

## Reading and writing

An agent normally enters through MCP:

1. `get_brief`
2. `list_work`
3. `get_item`
4. `claim_work`
5. work in the authoritative external systems
6. `record_event` and `attach_artifact` when another actor will need the result
7. `complete_work`, `handoff_work`, `block_work`, or `release_work`

A webhook receiver or orchestrator usually uses REST for the same operations.

Writes are commands and state transitions. They are not unrestricted object replacement. Each meaningful write updates current state inside a database transaction and appends an immutable event.

## What the claim locks

A claim is an advisory lease on a unit of intent:

> This actor is currently responsible for driving this item until the lease expires.

The claim is acquired with one atomic database update. A competing live claim fails. The claimant renews the lease while working. Expired claims return to ready work and leave a `claim.expired` event.

A claim does not lock repository files. Git branches, worktrees, merge conflicts, branch protections, and CI remain authoritative for source code.

Later, a separate reservation primitive can coordinate scarce resources such as staging environments, migration windows, test accounts, or benchmark capacity. Those reservations may use exclusive or capacity-limited leases. External systems should still enforce dangerous operations.

## Remote MCP

The web process exposes stateless Streamable HTTP at:

```text
POST /mcp
```

Remote MCP always requires a Stensibly Bearer token, even when REST authentication is disabled for local development.

Create a token:

```bash
STENSIBLY_DB=/absolute/path/to/stensibly.sqlite \
  bun run tokens create \
  --name remote-agent \
  --scopes read,write \
  --projects scrapbook
```

A remote client sends the emitted token in every MCP request:

```http
Authorization: Bearer stn.tok_...secret...
```

Project-scoped tokens must include the project when calling `list_work`. Item operations resolve the item's project before the MCP tool is invoked. Read-only tokens cannot call mutating tools.

The endpoint uses JSON response mode and creates a fresh MCP server/transport for each request. It does not maintain an in-memory agent session. Durable state belongs in SQLite.

Browser requests with an `Origin` header are rejected unless the origin appears in `STENSIBLY_ALLOWED_ORIGINS`. Deployments may also set an exact `STENSIBLY_ALLOWED_HOSTS` list.

## API stability

The REST API is currently an early native API, not a frozen public standard. Before a hosted release it should gain:

- an explicit `/api/v1` boundary
- generated OpenAPI documentation
- stable error codes
- pagination and cursors
- optimistic version checks for administrative edits
- workspace-scoped idempotency
- compatibility tests for each protocol adapter

The domain operations should settle before the public API is declared stable.

## Deployment

The current backend depends on a persistent SQLite file. Deploy it on a machine or container with durable disk.

A static landing page and documentation can be deployed on Vercel immediately. The stateful service should not be placed in an ephemeral serverless filesystem. A Vercel-hosted application backend requires moving persistence to a network database such as Postgres or a hosted SQLite-compatible service.

The first hosted topology can be:

```text
stensibly site/docs
    -> static web deployment

api / MCP service
    -> long-running Bun process
    -> persistent SQLite volume
```

A later topology can move the API and UI together after the storage adapter supports Postgres or hosted SQLite.

## The durable rule

Stensibly stores coordination facts and pointers to evidence.

Git stores code. CI stores verification. Artifact systems store outputs. Agent harnesses own their private execution trees. Stensibly records what work exists, who is responsible, what came back, and what happens next.
