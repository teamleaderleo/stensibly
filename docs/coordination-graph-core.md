# Coordination graph core

The coordination graph core is a bounded, deterministic readiness evaluator. It compiles admitted node facts and typed edges into current states and a human-readable queue. It performs no work and grants no provider, merge, deployment, or operation authority.

## Contract

A graph has one workspace, project, graph-policy version, schema version, and repository-owned compiler revision. Nodes use a stable ID plus an explicit positive generation. The generation is part of node identity; replacing `review@1` with `review@2` creates a new fact.

Every graph, node, receipt, edge, reference, dependency record, and array crosses an exact own-property admission boundary. Unknown or symbol fields, accessors, hidden fields, custom prototypes, sparse arrays, and decorated arrays fail before caller-controlled getters execute.

Each node binds:

- kind;
- workspace and project;
- definition fingerprint;
- environment fingerprint when relevant;
- node policy version;
- authority generation when relevant;
- owner when declared;
- declared state;
- optional bounded receipt.

## Complete receipt subject

A receipt proves one complete node input fingerprint. The subject includes:

- graph schema version;
- repository-owned compiler revision;
- graph-policy version;
- node ID and generation;
- node kind, workspace, and project;
- definition and environment fingerprints;
- node policy version;
- authority generation;
- owner identity;
- every accepted readiness predecessor's key, edge type, output fingerprint, and optional competition identity.

Changing owner, graph policy, compiler policy, node policy, authority generation, environment, definition, or accepted predecessor output rotates the expected fingerprint. A provider result alone advances nothing: the exact receipt disposition and declared state must agree.

Receipt observation time and optional expiry use canonical UTC. A receipt observed after the immutable evaluation time is stale. An expiry at or before evaluation is stale.

## Edge layers

Readiness edges are hard prerequisites:

- `requires`;
- `blocked_by`;
- `consumes_evidence`;
- `requires_review`;
- `requires_decision`;
- `requires_authority`;
- `produces`.

They must form an acyclic graph. Changed readiness inputs mark only reverse-reachable descendants as affected.

Causal edges are history and explanation:

- `supersedes`;
- `caused_by`;
- `continues`;
- `recovers`;
- `related`.

Causal cycles are valid and do not affect readiness or invalidation.

## Competing producers

An output may have one ordinary producer. Multiple producers require the same explicit `competitionId`; otherwise graph validation fails. A competition group satisfies readiness when at least one candidate has an accepted output. Every accepted candidate in the group contributes to the target input fingerprint.

## Evaluation order

For each node the evaluator:

1. resolves hard prerequisite states and accepted predecessor outputs;
2. computes the complete candidate input fingerprint;
3. validates exact receipt identity, observation time, expiry, and disposition;
4. emits the current state;
5. preserves `affected: true` as invalidation metadata.

A changed or reverse-reachable node may remain `accepted` when a fresh exact receipt proves the reevaluated inputs. An old or mismatched receipt becomes stale. A downstream node with accepted prerequisites and no fresh proof becomes eligible. This separates “the candidate changed” from “the current candidate lacks proof.”

## Evaluation states

The evaluator emits:

- `accepted` — matching fresh accepted receipt for the complete inputs;
- `eligible` — prerequisites are accepted and the current inputs lack reusable proof;
- `blocked` — a hard prerequisite is not accepted;
- `failed` — matching fresh failure receipt for the exact inputs;
- `ambiguous` — matching fresh ambiguous receipt requiring reconciliation;
- `stale` — fingerprint mismatch, future observation, expiry, missing fresh proof for a declared accepted affected node, or state/receipt disagreement;
- `revoked` — authority or accepted state was explicitly revoked;
- `unknown` — source state is explicitly unknown.

Unrelated accepted branches remain reusable.

## Bounds and deterministic identity

Schema version 1 accepts at most 500 nodes and 2,000 edges. IDs, slugs, policy versions, owners, timestamps, generations, and SHA-256 values are bounded and validated. Nodes, edges, and receipt dependencies are canonicalized and sorted with code-unit ordering before fingerprinting. Equivalent input ordering yields the same graph fingerprint, topological order, evaluation, and Markdown queue.

## Fieldwork boundary

Fieldwork integration keeps four owners separate:

1. canonical finding owns human technical meaning;
2. desired-state spec owns durable typed intent;
3. controller status owns generation-bound observations;
4. generated views remain disposable projections.

Graph state `accepted` means an exact node receipt proves declared inputs and disposition. It does not mean Fieldwork review `ACCEPT`, merge approval, or effective authority. Review, selected direction, and authority require explicit versioned nodes and receipts. Missing, inaccessible, skipped, prohibited, stale, expired, revoked, or unresolved facts remain unknown or denied.

## Current fence

This core does not:

- persist graph snapshots;
- read GitHub, CI, Convex, Vercel, or Cloudflare directly;
- mutate issues, branches, deployments, credentials, grants, or project state;
- infer review, selection, settlement, or authority from provider state;
- schedule workflows;
- implement the periodic compiler from issue #566.

Later slices may add accepted-input adapters, durable snapshots, reverse-reachability persistence, CI publication, and product projections. Those layers must preserve this evaluator's exact receipt subject and authority boundary.

— Kestrel · coordination graph repair
  Intention: preserve reusable proof across change while every accepted state remains attributable to one exact generation and policy subject.
