# Persisted GitHub project context

This slice stores selected GitHub issue observations in the SQLite compatibility
backend. GitHub remains authoritative for issue state and discussion. Stensibly
stores a bounded observation plus the exact project and instruction context under
which a worker accepted it.

## Record identity

Each accepted record is scoped by:

- workspace;
- Stensibly project;
- canonical GitHub issue identity;
- accepted project-attachment record and snapshot;
- accepted instruction-set identity;
- provider source revision;
- observation and acceptance times.

The issue body is never stored. The imported issue snapshot carries only body
presence, byte length, and a SHA-256 content identity.

## Acceptance rules

Acceptance is append-only.

- Exact replay of the same issue snapshot, binding, and observation time returns
  the existing record.
- A later observation of unchanged provider content appends a new observation
  receipt.
- Changed content under the same provider revision is a conflict.
- An older provider update cannot replace newer accepted context.
- A changed project attachment or instruction set creates a new explicit binding.
- The issue repository must appear in the accepted project attachment.
- Instruction-set identity must reference the current accepted attachment exactly.

Freshness is a projection, not a semantic transition. A record is `fresh`,
`stale`, or `degraded` from its observation age and current source availability.
Those states never close, reopen, complete, claim, block, or otherwise mutate
either the GitHub issue or Stensibly work.

## SQLite boundary

`SqliteGitHubProjectContextStore` owns this compatibility implementation. It uses
an append-only table and returns the newest accepted record per
workspace/project/issue identity.

This slice deliberately excludes:

- Convex persistence;
- REST or MCP tools;
- dashboard projection;
- GitHub OAuth, webhook intake, or polling;
- synchronization cursors;
- outbound GitHub mutations;
- read-after-write receipts;
- authority grants or execution-state transitions.

Those belong in later #492 slices after the storage contract proves stable.
