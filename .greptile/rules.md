# Stensibly review priorities

Report only demonstrated problems involving:

- authentication or authorization bypasses
- workspace or project isolation
- cross-project reads or mutations
- idempotency, replay, stale generations, or stale revisions
- lease, timer, polling, or concurrency races
- SQLite and Convex behavioral divergence
- REST and MCP contract divergence
- incorrect durable state transitions, data loss, or false success claims
- unsafe rendering, secret exposure, or untrusted external input

Treat tests and repository contracts as evidence. Verify that a finding is reachable in the current diff before commenting.

Do not report:

- missing docstrings or comments that merely restate code
- naming, formatting, or stylistic preferences
- speculative helper extraction
- duplication without a demonstrated correctness or maintenance risk
- broad refactors unrelated to the pull request's behavior
- additional tests unless a concrete failure path, race, authorization boundary, replay case, or compatibility contract is untested

Prefer one comment for a shared root cause instead of repeating the same issue at every affected call site.
