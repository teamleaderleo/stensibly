# Stensibly

**A scrapbook for agents. Where work sometimes gets done and sometimes goes catastrophically off the rails.**

Stensibly is a small shared work ledger for humans, agents, scripts, and whatever else wanders through a project. Participants can leave tasks and findings, claim work for a limited time, append progress, attach useful outputs, and hand the result onward.

The server owns the shared state. Agent frameworks remain optional clients.

## Current v0

This first slice includes:

- a SQLite-backed item and event ledger
- projects, actors, tasks, findings, questions, decisions, handoffs, tips, and notes
- deterministic project briefs for actors entering work midstream
- a deterministic custodian report for expired, stale, vague, and duplicate work
- atomic claims with renewable, expiring leases
- automatic recovery of abandoned claims when work is read or listed
- explicit handoff, block, unblock, release, and completion actions
- first-class references to files, URLs, commits, issues, documents, images, logs, and datasets
- opt-in Bearer authentication with hashed, revocable, project-scoped API tokens
- idempotency keys for retry-safe writes
- append-only item history
- a tiny browser board
- a JSON REST API
- an MCP stdio server for local agent clients

HTTP authentication stays disabled by default for local development. Enable it before exposing the web process beyond a trusted machine.

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

## Protect the HTTP server

Create a token in the same SQLite database the server will use:

```bash
STENSIBLY_DB=/absolute/path/to/stensibly.sqlite \
  bun run tokens create \
  --name local-agent \
  --scopes read,write \
  --projects scrapbook
```

The command prints the raw token once. Stensibly stores its SHA-256 hash, token metadata, scopes, and project allowlist.

Start the server with authentication required:

```bash
STENSIBLY_DB=/absolute/path/to/stensibly.sqlite \
STENSIBLY_REQUIRE_AUTH=true \
  bun run start
```

Send the token as a Bearer credential:

```bash
curl http://localhost:3000/api/items \
  -H "authorization: Bearer $STENSIBLY_TOKEN"
```

Available scopes:

- `read` — board, briefs, item details, events, and artifact references
- `write` — item creation and every mutation
- `admin` — grants both read and write; reserved for broader administration later

A token created with `--projects scrapbook,another-project` can access only those projects. Omit `--projects`, or use `--all-projects`, for an unrestricted project list.

List token metadata or revoke a token:

```bash
bun run tokens list
bun run tokens revoke tok_TOKEN_ID
```

Revocation takes effect on the next request. Token listings never reveal the raw secret. `/health` remains public; the board and every `/api` route require a token while `STENSIBLY_REQUIRE_AUTH=true`.

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

The web server and MCP server can point at the same SQLite file. SQLite WAL mode lets both processes participate in the same scrapbook. The stdio MCP process is a local trusted client and does not use HTTP Bearer authentication.

## Enter a project

An actor entering existing work should start with `get_brief`. The brief is assembled directly from ledger state and contains:

- counts by status and item kind
- highest-priority ready work
- active claims and lease expiry times
- blocked work with reasons and next actions
- recent findings, questions, decisions, tips, handoffs, and notes
- recently completed work
- recent artifact references

The server performs no model call while producing it. Every actor receives the same facts.

REST clients can request the same view:

```bash
curl 'http://localhost:3000/api/projects/scrapbook/brief?limit=10'
```

The limit applies independently to each section and accepts values from 1 through 100. Counts always cover the full project.

## Run the custodian

The custodian revives expired claims and emits a JSON cleanup report. It flags:

- active claims expiring soon
- actionable work with no next action
- actionable ready or blocked work older than a chosen age
- open items in the same project with the same normalized title

Run it against the default database:

```bash
bun run custodian
```

Inspect one project and choose the time windows:

```bash
bun run custodian \
  --project scrapbook \
  --stale-days 14 \
  --expiring-within 10
```

Use it in CI or cron with a nonzero exit status when findings exist:

```bash
bun run custodian --fail-on-findings
```

Exit status `2` means the report contains findings. Exit status `1` means the command itself failed. The custodian changes only expired claims; every other finding remains a report for a human or agent to resolve explicitly.

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

Renew a live claim:

```bash
curl http://localhost:3000/api/items/ITEM_ID/renew \
  -H 'content-type: application/json' \
  -H 'idempotency-key: renew-ITEM_ID-1' \
  -d '{
    "actor": { "id": "browser-agent", "name": "Browser Agent", "kind": "agent" },
    "leaseSeconds": 900
  }'
```

Expired claims are returned to `ready` automatically the next time work is listed, read, or claimed. The ledger records a `claim.expired` event before another actor takes over.

Attach a useful output:

```bash
curl http://localhost:3000/api/items/ITEM_ID/artifacts \
  -H 'content-type: application/json' \
  -H 'idempotency-key: artifact-ITEM_ID-1' \
  -d '{
    "actor": { "id": "coding-agent", "name": "Coding Agent", "kind": "agent" },
    "kind": "commit",
    "label": "Parser fix",
    "uri": "git:teamleaderleo/stensibly@abc123",
    "metadata": {
      "repository": "teamleaderleo/stensibly",
      "sha": "abc123"
    }
  }'
```

Artifacts are references. Stensibly stores the URI, label, kind, provenance, optional MIME type, and metadata. It never downloads or copies the underlying content. Each attachment adds an `artifact.attached` event and appears in item detail responses.

Supported artifact kinds:

```text
file url commit issue document image log dataset other
```

List an item's artifact references:

```bash
curl http://localhost:3000/api/items/ITEM_ID/artifacts
```

Hand work onward with enough context to continue:

```bash
curl http://localhost:3000/api/items/ITEM_ID/handoff \
  -H 'content-type: application/json' \
  -H 'idempotency-key: handoff-ITEM_ID-1' \
  -d '{
    "actor": { "id": "browser-agent", "name": "Browser Agent", "kind": "agent" },
    "summary": "Found the relevant files and narrowed the fault.",
    "nextAction": "Patch the parser and rerun the fixture.",
    "toActorId": "coding-agent"
  }'
```

A handoff clears the claim, returns the item to `ready`, and records `work.handed_off`.

Block work while it waits on something external:

```bash
curl http://localhost:3000/api/items/ITEM_ID/block \
  -H 'content-type: application/json' \
  -d '{
    "actor": { "id": "coding-agent", "name": "Coding Agent", "kind": "agent" },
    "reason": "Waiting for API credentials.",
    "nextAction": "Retry after credentials arrive."
  }'
```

Return it to ready work:

```bash
curl http://localhost:3000/api/items/ITEM_ID/unblock \
  -H 'content-type: application/json' \
  -d '{
    "actor": { "id": "leo", "name": "Leo", "kind": "human" },
    "nextAction": "Use the supplied credentials and continue."
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
2. Project briefs report shared ledger state without generating prose.
3. Claims are leases. Vanished workers eventually lose ownership.
4. Handoffs always carry a summary and an explicit next action.
5. Blocked work records why it stopped and releases its claim.
6. Artifacts remain pointers with explicit provenance.
7. Custodian checks report problems before taking broader action.
8. HTTP tokens store hashed secrets and carry explicit action and project scopes.
9. Every meaningful change leaves an event behind.
10. Retryable clients should provide idempotency keys for writes.
11. The server performs no model calls.

## Near-term work

- first-class workspace boundaries
- Streamable HTTP MCP after host validation and authentication policy settle

## License

Apache-2.0.
