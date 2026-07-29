# Canonical GitHub issue context

Issue #492 makes selected GitHub issues and accepted repository instructions explicit Stensibly project context while keeping GitHub independently usable as the public project record.

This document defines the first pure contract slice: one bounded deterministic observation of one GitHub issue. It performs no provider request, persistence, synchronization, mutation, authority decision, or execution-state transition.

## Stable identity

A GitHub issue uses one canonical external identity:

```text
github:owner/repository#number
```

For example:

```text
github:teamleaderleo/stensibly#403
```

The same reference also produces the canonical public URL:

```text
https://github.com/teamleaderleo/stensibly/issues/403
```

Owner and repository names are normalized to lowercase because GitHub repository identity is case-insensitive. Issue numbers remain positive integers. A number collision in another repository is a different external identity.

## Bounded snapshot

`buildGitHubIssueContext()` accepts one explicit provider observation and produces a versioned immutable snapshot containing:

- stable GitHub issue identity and canonical URL;
- bounded title;
- body presence, byte length, and SHA-256 revision evidence;
- open or closed state and bounded state reason;
- canonical labels and assignees;
- optional milestone number and title;
- explicit parent, sub-issue, blocked-by, blocks, and related references;
- created and updated timestamps;
- optional provider node identity;
- an opaque bounded source revision supplied by the integration;
- content and whole-snapshot fingerprints.

The issue body itself is deliberately absent from the returned snapshot. The first slice retains only bounded revision evidence so runner context and synchronization records do not silently accumulate unrestricted issue prose or discussion history.

A later authorized reader can fetch the exact GitHub source when the body is useful. Repository text remains untrusted evidence and never grants execution authority.

## Source revision

`sourceRevision` is the integration's stable identity for the exact provider observation. A later adapter may derive it from a provider node update identity, ETag, cursor, delivery identity, or a digest of an exact fetched representation.

The pure contract accepts a bounded opaque ASCII token. It does not claim that an issue timestamp alone is a complete source revision.

Retries use both stable external identity and source revision:

- same identity, same revision, same content: `identical`;
- same identity, same revision, changed content: `altered_revision_conflict`;
- same identity, changed revision, newer observation: `updated`;
- same identity, changed revision, older `updatedAt`: `stale`;
- changed identity: `different_issue`.

A stale observation is still valid evidence. The comparison classification does not authorize overwriting newer accepted state.

## Deterministic ordering

All security- and identity-relevant collections use explicit Unicode code-unit ordering:

```text
left < right ? -1 : left > right ? 1 : 0
```

The contract does not use locale-sensitive collation. Labels, assignees, relationship keys, changed-field names, and canonical JSON object keys therefore retain the same ordering across Bun, Node, workerd, operating-system locales, and future runtime environments.

Equivalent input ordering produces the same content and snapshot fingerprints.

## Explicit relationships only

The snapshot accepts only relationships explicitly supplied by an authorized provider adapter or another reviewed source:

- `parent`;
- `sub_issue`;
- `blocked_by`;
- `blocks`;
- `related`.

It never infers a relationship from timestamps, issue order, prose, callsigns, labels, milestones, or adjacent activity. Duplicate and self-targeting references fail validation.

This rule supports #149 and #403: a visual thread or dependency projection must consume explicit durable references rather than reverse-engineering causality.

## State separation

This snapshot records GitHub-owned provider state. It does not contain or mutate Stensibly execution state.

GitHub may report:

- issue open or closed;
- labels and assignees;
- milestone and explicit provider relationships.

Stensibly may separately report:

- ready, claimed, active, blocked, handed off, completed, or awaiting reconciliation;
- holder, run, generation, authority, approval, blocker, and next action.

A closed GitHub issue does not silently complete Stensibly responsibility. A completed Stensibly item does not silently close a GitHub issue. Cross-system effects require explicit policy, an exact capability grant, a provider receipt, and read-after-write verification.

## Security and privacy boundary

The builder:

- bounds list sizes, strings, and issue-body bytes;
- rejects control and bidirectional text controls from display and identity fields;
- validates GitHub owner, repository, issue number, timestamps, provider node identity, and source revision;
- normalizes CRLF body input before hashing;
- rejects duplicate labels, assignees, and relationships;
- returns frozen records;
- verifies snapshot consistency before comparison.

SHA-256 values are deterministic identities and integrity checks, not signatures. A later persistence layer must establish which accepted snapshot and source revision are authoritative.

## Non-goals

This slice performs no:

- GitHub API call or OAuth flow;
- webhook intake or signature verification;
- polling or cursor storage;
- SQLite or Convex persistence;
- REST, MCP, or dashboard projection;
- GitHub issue comment, label, assignment, body, state, or relationship mutation;
- project-attachment parsing or import;
- context-packet mutation;
- claim, lease, capability, approval, or execution transition;
- inferred dependency or causal relationship;
- unrestricted issue body, comment, review, or event-history import.

## Follow-up integration

A later reviewed #492 slice should:

1. persist selected snapshots under workspace and project isolation;
2. bind them to the accepted repository attachment from #217/#253;
3. record the accepted repository instruction-set identity used by a run;
4. ingest attributable provider updates through a verified bounded adapter;
5. expose synchronization freshness, degraded state, and conflicts through REST, MCP, and the dashboard;
6. represent outbound GitHub proposals and provider receipts separately;
7. reconcile ambiguous writes through read-after-write verification;
8. keep GitHub readable and writable while Stensibly is degraded.

The existing project attachment remains the source of accepted static repository policy. This GitHub issue context adds provider-object identity and revision tracking; it does not create a second `STENSIBLY.md` parser, project attachment, context-packet system, or authority model.
