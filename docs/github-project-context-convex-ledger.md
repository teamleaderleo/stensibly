# Hosted accepted GitHub project context

This slice persists deliberately accepted, content-minimised GitHub issue context in the hosted Convex control plane. GitHub remains authoritative for repository and issue state; the table is an append-only record of what Stensibly accepted for one workspace/project recovery view.

## Admission and identity

Every write reuses the landed `github-project-context-admission` compiler for the complete issue snapshot, repository instruction set, synchronization evidence, observation identity, chronology, and accepting actor. The mutation also binds the exact current project attachment, rechecks its fingerprint, and requires that attachment to declare the canonical GitHub repository.

Before repository authorization, the mutation re-admits the stored attachment snapshot as bounded JSON and binds its top-level field set, exact-text SHA-256 fingerprint, project slug, source path, source content fingerprint, and durable row metadata. A changed repository list cannot ride through an older attachment hash.

One deterministic record identity is derived from workspace, project, and observation reference. Exact replay returns the original row. Changed reuse of an observation reference conflicts, and one source revision with changed content conflicts before another row is inserted.

Observation chronology is checked before instruction rebound. Older evidence is retained as `stale` history and cannot demote the current row. The mutation permits at most five minutes of provider-clock lead; service readback applies the same allowance so every valid committed observation remains admissible. A single Convex transaction patches the prior current row and appends the new generation, so concurrent acceptance leaves one current generation.

## Durable shape and readback

The durable row stores canonical snapshot and instruction-set JSON plus their independently admitted identities, provider update time, attachment binding, synchronization state, observation evidence, acceptance evidence, outcome, and current marker. Raw issue body text is absent.

Mutation results, query arrays, existing/current rows used during acceptance, stored rows, snapshot JSON, and instruction JSON are re-admitted before they leave Convex or become the bounded project-context projection. Unknown nested fields, duplicate JSON keys, forged fingerprints, altered metadata columns, malformed timestamps, and wider repository bindings fail closed.

History is bounded and ordered by acceptance time with deterministic record identity as its tie-breaker.

## Hosted composition

`ConvexGitHubProjectContextService` provides trusted acceptance plus the existing `GitHubProjectContextLedger` read contract. `ConvexWorkLedger` delegates the read and trusted acceptance methods to that service, so the later scoped MCP action can consume the same hosted ledger without advertising an unavailable capability.

## Boundary and recovery

This slice adds no public MCP registration, provider fetch, webhook change, GitHub mutation, raw provider payload, credential, deployment, or migration that deletes prior data. New acceptance can be disabled while append-only rows remain available for bounded export or projection repair. Before downstream public dependence, recovery is one squash revert.

<!-- loom-ci-trigger -->
