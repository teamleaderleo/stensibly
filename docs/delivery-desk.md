# Delivery Desk

The Delivery Desk is a small finish-line projection over canonical Stensibly issues and pull requests. It answers one operational question:

> Which selected implementation is closest to integration, and what exact bounded gate remains?

It does not replace the backlog, review queue, issue acceptance criteria, pull-request discussion, CI, deployment receipts, or the coordination compiler.

The current dogfood snapshot is [`delivery-desk-current.json`](./delivery-desk-current.json). It is deliberately versioned and fingerprinted so a changed head or required input can be recognized instead of silently inheriting an old status.

## States

- `land-now` — exact accepted head, executed evidence, exact review identity, no carrier, and one named integration gate;
- `final-gate` — one canonical implementation has executed evidence and one bounded review, compatibility, execution, or receipt-transfer gate remains;
- `polish` — the selected implementation still contains a temporary carrier, needs direct source transfer, or has a repair disposition;
- `decision` — one explicit policy or product decision is required before implementation can advance.

A workflow, temporary branch, validation archive, or repair recipe is never a `land-now` candidate.

## Required facts

Every entry binds:

- one canonical GitHub issue;
- one canonical implementation pull request and branch;
- the exact lowercase 40-character head SHA;
- risk tier;
- evidence actually executed, each with a timestamp and SHA-256 identity;
- integration/review disposition;
- one bounded remaining gate;
- current owner or `null`;
- any removable execution carrier and its exact head;
- hosted/deployed state;
- exact required-input and review fingerprints.

The projection rejects unknown fields, noncanonical issue or pull-request URLs, unsafe branch names, loose timestamps, duplicate evidence, duplicate canonical issues or implementations, and noncanonical finish-line ordering.

## Movement and invalidation

`evaluateDeliveryDeskEntry()` compares the retained entry with current observed facts. These changes invalidate the selected landing status:

- implementation head movement;
- required-input fingerprint movement;
- review fingerprint movement;
- executed-evidence set movement;
- carrier appearance, disappearance, or head movement.

A stale `land-now` or `final-gate` entry falls back to `polish`. Work already requiring an explicit decision remains `decision` rather than being misreported as ordinary cleanup.

The evaluator never retries work, mutates GitHub, merges, deploys, grants provider access, or authorizes integration. Every evaluation returns `authorizesIntegration: false`.

## Canonical ordering

Entries are ordered by finish-line state and then canonical issue identity:

1. `land-now`;
2. `final-gate`;
3. `polish`;
4. `decision`.

Evidence is ordered by kind, reference, observation time, and fingerprint. The projection fingerprint covers the complete canonical record.

## Operating rule

Update the canonical issue and pull request first. Refresh or remove the Delivery Desk entry afterward.

Entries leave the desk immediately after merge and integration closeout, explicit hold, supersession, or completion. The desk may point to evidence; it never becomes the authority that produced that evidence.
