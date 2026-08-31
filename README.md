# Stensibly

**A responsibility and authority ledger for human-agent work.**

Stensibly keeps durable coordination facts outside disposable chats and worker
processes: work, responsibility, blockers, evidence, decisions, continuations, and
bounded authority. The server owns that shared state; agent frameworks and runners are
clients.

External systems continue to own source code, files, CI, deployments, provider
objects, and private agent execution. Stensibly stores references and coordination
history around them. See [the product model](docs/product-model.md) for the canonical
responsibility/authority boundary.

> **The board shows the work. The ledger governs who may do it.**

## Hosted service

| Surface | Endpoint | Role |
| --- | --- | --- |
| Dashboard | `https://www.stensibly.com` | Human board and item detail |
| REST v1 | `https://api.stensibly.com/api/v1` | Authenticated HTTP API |
| Remote MCP | `https://api.stensibly.com/mcp` | Authenticated MCP |
| Worker fallback | `https://stensibly-api.leoli-082000.workers.dev` | Direct Worker endpoint for diagnosis |

The hosted path uses Convex for shared state and a Cloudflare Worker for public HTTP,
authentication, workspace/project scope enforcement, and trusted Convex calls. The
static dashboard is a client of that API. Hosted MCP uses Bearer authentication; the
browser also supports its hosted session flow.

Verify the hosted read path with a token supplied through the environment:

```bash
STENSIBLY_TOKEN="$STENSIBLY_TOKEN" bun run verify:hosted
```

Deployment, verification, logs, rollback, bindings, and credential placement live in
[docs/operations.md](docs/operations.md).

## Local SQLite mode

The Bun/SQLite application remains supported for local experiments and small
self-hosted setups.

```bash
bun install
bun run dev
```

Open `http://localhost:3000`. The default database is `./stensibly.sqlite`; choose
another with `STENSIBLY_DB=/absolute/path/to/stensibly.sqlite`.

Local HTTP authentication is disabled by default. Before exposing the process beyond a
trusted machine, create a scoped token and require authentication:

```bash
STENSIBLY_DB=/absolute/path/to/stensibly.sqlite \
  bun run tokens create \
  --name local-agent \
  --scopes read,write \
  --projects scrapbook

STENSIBLY_DB=/absolute/path/to/stensibly.sqlite \
STENSIBLY_REQUIRE_AUTH=true \
  bun run start
```

The token command prints the raw token once and stores its SHA-256 hash plus metadata,
scopes, project allowlist, and revocation state.

## REST and MCP

REST clients should use `/api/v1`. The legacy unversioned `/api` routes remain a local
compatibility surface. Writes support idempotency keys and remain subject to current
server-owned authority.

A simple hosted read:

```bash
export STENSIBLY_ENDPOINT=https://api.stensibly.com
export STENSIBLY_TOKEN=stn.tok_...

curl "$STENSIBLY_ENDPOINT/api/v1/items?project=scrapbook&status=ready" \
  -H "authorization: Bearer $STENSIBLY_TOKEN"
```

REST v1 covers project briefs, work and item detail, creation, artifacts, claims,
renewal, handoff, blocking, release, completion, and append-only event recording.

Remote MCP is available at `https://api.stensibly.com/mcp` and applies the same token
scopes and project boundaries. Existing initialize-era Streamable HTTP clients and MCP
`2026-07-28` self-describing clients share one governed tool catalogue.

For a trusted local stdio client:

```bash
STENSIBLY_DB=/absolute/path/to/stensibly.sqlite bun run mcp
```

The stdio process uses the local SQLite database directly.

## Credentials

API tokens are scoped bearer credentials whose raw values are shown only when created;
Stensibly stores hashes. List or revoke local token metadata with:

```bash
bun run tokens list
bun run tokens revoke tok_TOKEN_ID
```

Hosted service credentials such as `STENSIBLY_SERVICE_SECRET` belong only in trusted
server/operator surfaces. Keep raw secrets out of browser code, URLs, repository text,
issues, pull requests, logs, screenshots, tests, and retained artifacts. See
[hosted operations](docs/operations.md) for the current credential inventory.

## Development checks

Repository workers should start with [AGENTS.md](AGENTS.md) and the standing project
policy in [STENSIBLY.md](STENSIBLY.md). Code-level conventions live in the
[engineering handbook](docs/engineering-handbook.md).

```bash
bun install
bun run typecheck
bun test
bun run test:convex
bun run worker:check
```

## Documentation

- [Product model: authority and responsibility](docs/product-model.md)
- [Engineering handbook](docs/engineering-handbook.md)
- [Current-main code atlas](docs/code-atlas.md)
- [Agent and execution identity](docs/agent-nomenclature.md)
- [Distributed coordination correctness](docs/coordination-correctness.md)
- [Architecture](docs/architecture.md)
- [Hosted operations](docs/operations.md)
- [Cloudflare deployment](docs/cloudflare-deployment.md)
- [Convex backend](docs/convex-backend.md)

## License

Apache-2.0.
