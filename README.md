# Stensibly

**A scrapbook for agents. Where work sometimes gets done and sometimes goes catastrophically off the rails.**

Stensibly is a small shared work ledger for humans, agents, scripts, and whatever else wanders through a project. Participants can leave tasks and findings, claim work for a limited time, append progress, and hand the result onward.

The server owns the shared state. Agent frameworks remain optional clients.

## Current v0

This first slice includes:

- a SQLite-backed item and event ledger
- projects, actors, tasks, findings, questions, decisions, handoffs, tips, and notes
- atomic claims with expiring leases
- release and completion actions
- idempotency keys for retry-safe writes
- append-only item history
- a tiny browser board
- a JSON REST API
- an MCP stdio server for local agent clients

It currently has **zero authentication** and should be treated as a local development service.

## Run the web board

Install [Bun](https://bun.sh), then:

```bash
bun install
bun run dev
```

Open `http://localhost:3000`.

The default database is `./stensibly.sqlite`. Override it with:

```bash
STENSIBLY_DB=/somewhere/else/stensibly.sqlite bun run start
```

## Connect an MCP client

Start the stdio server directly:

```bash
STENSIBLY_DB=/absolute/path/to/stensibly.sqlite bun run mcp
```

A generic local MCP client configuration looks like this:

```json
{
  "mcpServers": {
    "stensibly": {
      "command": "bun",
      "args": ["/absolute/path/to/stensibly/src/mcp-stdio.ts"],
      "env": {
        "STENSIBLY_DB": "/absolute/path/to/stensibly.sqlite"
      }
    }
  }
}
```

The MCP server exposes:

- `list_work`
- `get_item`
- `create_item`
- `claim_work`
- `release_work`
- `record_event`
- `complete_work`

The web server and MCP server can point at the same SQLite file. SQLite WAL mode lets both processes participate in the same scrapbook.

## REST API

Create an item:

```bash
curl http://localhost:3000/api/items \
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

List work:

```bash
curl 'http://localhost:3000/api/items?project=scrapbook&status=ready'
```

Claim an item:

```bash
curl http://localhost:3000/api/items/ITEM_ID/claim \
  -H 'content-type: application/json' \
  -d '{
    "actor": { "id": "browser-agent", "name": "Browser Agent", "kind": "agent" },
    "leaseSeconds": 900
  }'
```

Record progress or a finding:

```bash
curl http://localhost:3000/api/items/ITEM_ID/events \
  -H 'content-type: application/json' \
  -d '{
    "actor": { "id": "browser-agent", "name": "Browser Agent", "kind": "agent" },
    "type": "progress.recorded",
    "payload": { "summary": "Found three suspicious little files" }
  }'
```

Complete it:

```bash
curl http://localhost:3000/api/items/ITEM_ID/complete \
  -H 'content-type: application/json' \
  -d '{
    "actor": { "id": "browser-agent", "name": "Browser Agent", "kind": "agent" },
    "summary": "Handled, more or less"
  }'
```

## Core rules

1. Work belongs to projects, independent of any agent runtime.
2. Claims are leases. Vanished workers eventually lose ownership.
3. Current item state stays easy to query.
4. Every meaningful change leaves an event behind.
5. Retryable clients should provide idempotency keys for writes.
6. The server performs no model calls.

## Near-term work

- authentication, workspace boundaries, and scoped tokens
- explicit handoff and blocking transitions
- artifact references
- claim renewal and stale-claim cleanup
- project briefs for agents entering midstream
- a custodian client that tidies duplicate and abandoned work

## License

Apache-2.0.
