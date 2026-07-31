# Hosted GitHub repository observation ledger

Tracking: #591 under campaign #744.

## Purpose

Persist the content-minimised output of the signed GitHub webhook compiler so hosted Stensibly can reconstruct repository chronology without retaining webhook payloads or treating provider observations as execution authority.

The ledger is append-only for accepted observations. Derived current state and provider reconciliation remain later lanes.

## Input boundary

The hosted webhook route verifies the GitHub signature and maps a supported event into `GitHubRepositoryObservationV1` before this ledger is called.

The durable boundary re-admits the canonical observation JSON and verifies:

- exact delivery, event, repository, subject, and observation identity;
- exact payload and semantic fingerprints;
- canonical source and receipt times;
- closed event, subject, relationship, ref, and content-revision vocabularies;
- bounded primitive facts;
- content-revision hashes and byte counts;
- `containsRawContent: false`;
- recomputed semantic fingerprint over the complete canonical semantics.

The webhook payload, issue/comment/review bodies, provider error text, credentials, prompts, patches, and arbitrary logs are never stored.

## Replay and conflict

- The first accepted delivery creates one immutable row.
- Exact replay of the same delivery and observation returns `duplicate: true` and creates no row.
- Reuse of one delivery or observation identity with changed content fails with a typed conflict.
- A different delivery remains a distinct chronological observation even when its semantic content matches an earlier delivery.

History is not rewritten to resolve conflicts.

## Read model

The first read surface returns at most 100 recent observations for one canonical repository, ordered by receipt time. Every row is rechecked against its canonical stored JSON before it is returned.

This read surface grants no claim, completion, approval, capability, scheduling, retry, merge, deployment, or provider mutation authority.

## Deliberate boundary

This slice does not add:

- unsupported webhook event families;
- GitHub API polling or reconciliation;
- a mutable current-state projection;
- accepted project context from #747;
- ProofWake bridge consumption;
- a public MCP action;
- provider reads or writes;
- retention deletion or compaction.

## Recovery

Disable the repository observation sink to stop new durable writes while retaining accepted rows. Repair read projections by replaying the append-only observations. Revert the integration commit before any later migration depends on the table.
