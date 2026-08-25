# Glaeda receipt intake boundary

This document defines Stensibly's current integration boundary for **Glaeda**, the project formerly named SmolRunner.

The original receipt contract was developed during the historical SmolRunner pilot in #260. Its v1 producer and reference identities are durable compatibility facts. Stensibly therefore uses Glaeda names for the present product-facing integration while continuing to decode exact SmolRunner v1 receipts without reinterpreting their bytes.

Upstream `teamleaderleo/smolrunner#751` owns the future Glaeda execution-receipt successor. Until that successor is defined, the current Glaeda-facing API decodes the historical SmolRunner v1 generation only.

## Compatibility generations

### Historical SmolRunner v1

`src/smolrunner-receipt-intake.ts` remains the exact legacy decoder. The following identities stay SmolRunner because they identify the old emitted format:

- `attempt.executorAdapter = "smolrunner"`;
- `receipt.producer.name = "smolrunner"`;
- `smolrunner:workspace:*` workspace receipt references;
- `smolrunner:log:*` log references;
- `smolrunner:artifact:sha256:*` artifact references;
- `test/fixtures/smolrunner-receipt-progress-v1.json`;
- `test/fixtures/smolrunner-receipt-completed-v1.json`.

Those fixtures are compatibility evidence. Keep them byte-for-byte truthful to the generation they represent.

### Current Glaeda-facing integration

`src/glaeda-receipt-intake.ts` is the current module-facing entry point. It exposes Glaeda-named aliases for the existing parser, schemas, transition comparison, and liveness projection while the only admitted wire generation remains SmolRunner v1.

Calling `parseGlaedaReceiptIntake` therefore means "parse a receipt accepted by the current Glaeda integration boundary"; today that accepted receipt is specifically the historical SmolRunner v1 format.

### Future Glaeda successor

When upstream #751 defines a Glaeda producer/schema generation, add it as an explicit second admitted generation. Preserve the SmolRunner v1 decoder for old evidence and branch on the exact supported producer/version contract. Never change old v1 literals in place or silently treat old canonical bytes as Glaeda bytes.

## Ownership split

Stensibly remains authoritative for:

- workspace, project, item, claim generation, run generation, and lease generation;
- the execution-envelope version and approved runner/verification profiles;
- durable attempt state, replay, conflict, stall, retry, handoff, fallback, and next action;
- deciding whether a receipt belongs to the current attempt;
- preserving repository, base, candidate-head, workspace-receipt, and authority-policy identity.

Glaeda remains authoritative for:

- queue and reservation evidence;
- runner/workspace preparation and resource enforcement;
- exact execution and checkpoint identity;
- heartbeat and lease evidence while the executor is active;
- bounded progress, continuation barriers, terminal outcome, cleanup, and public receipt evidence;
- converting private runtime state into its documented public receipt generation.

Neither side gains merge, deployment, credential, spending, or provider-administration authority through receipt intake.

## Replay and conflict

The current parser validates the complete admitted public intake and computes a canonical fingerprint from the validated attempt and receipt semantics. Replay comparison classifies an incoming checkpoint as:

- `insert` — first accepted checkpoint;
- `duplicate` — exact same checkpoint generation and complete validated semantic fingerprint;
- `advance` — exactly the next checkpoint generation, the same immutable execution identity, and an allowed state transition;
- `stale` — an older checkpoint generation;
- `conflict` — changed attempt/execution identity, changed same-generation semantics, a checkpoint gap, candidate-head regression, terminal mutation, invalid state order, or observation-time reversal.

A different execution ID, producer version, operation family, or operation schema never creates an implicit fallback. Fallback or handoff must create an explicitly superseding Stensibly attempt under the owning run policy.

## Heartbeat and named waits

Only `starting`, `running`, and `verifying` receipts claim active heartbeat evidence. Stensibly projects `stalledAt` from the earlier of three missed heartbeat intervals after the last durable observation or the receipt's lease expiry.

`waiting_external` and `continuation_required` remain named waits with explicit next actions. Queue and reservation states remain separately visible.

## Scope

This integration provides strict receipt admission, deterministic fingerprinting, replay/conflict classification, pure liveness projection, and historical SmolRunner v1 compatibility evidence. It adds no authority, provider mutation, live runner invocation, database ownership, retry command, or fallback executor semantics.
