# Glaeda receipt intake boundary

This document defines Stensibly's current integration boundary for **Glaeda**, the project formerly named SmolRunner.

The original receipt contract was developed during the historical SmolRunner pilot in #260. Its v1 producer and reference identities are durable compatibility facts. Stensibly uses Glaeda names for the present product-facing integration while continuing to decode exact SmolRunner v1 receipts with their original identity.

Upstream `teamleaderleo/smolrunner#751` owns the future Glaeda execution-receipt successor. Until that successor is defined, the current Glaeda-facing API admits the historical SmolRunner v1 generation only.

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

`src/glaeda-receipt-intake.ts` is the current module-facing entry point. It exposes Glaeda-named parsing, transition comparison, and liveness operations while keeping the admitted wire schemas explicitly labelled as legacy SmolRunner v1.

Calling `parseGlaedaReceiptIntake` means "parse a receipt accepted by the current Glaeda integration boundary"; today that accepted receipt is specifically the historical SmolRunner v1 format.

### Future Glaeda successor

When upstream #751 defines a Glaeda producer/schema generation, add it as an explicit second admitted generation. Preserve the SmolRunner v1 decoder for old evidence and branch on the exact supported producer/version contract. Old v1 literals and canonical bytes keep their original identity.

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

Receipt intake grants zero merge, deployment, credential, spending, or provider-administration authority.

## Intake identity

Every admitted SmolRunner v1 intake binds the public receipt to an exact Stensibly attempt:

- `attemptId`;
- workspace, project, and item IDs;
- exact claim, run, and lease generations;
- exact execution-envelope version;
- legacy executor adapter `smolrunner`;
- approved runner profile;
- canonical lower-case `owner/repository` identity;
- requested base and immutable resolved base commit;
- current published candidate head, when one exists;
- approved verification profile;
- opaque legacy SmolRunner workspace receipt reference.

The receipt repeats the envelope version, repository, runner profile, verification profile, workspace receipt, and exact source commit. Cross-boundary drift fails validation.

Candidate heads remain mutable attempt evidence. A later checkpoint may publish a new exact head. Replaying the same checkpoint generation with different head or other semantics conflicts, and a later checkpoint cannot regress from a known head to `null`.

Within one execution ID, the producer version and operation family/schema are immutable. A later checkpoint that changes any of those fields conflicts as changed execution identity.

## Public receipt limits

The admitted legacy receipt contains only bounded machine fields:

- producer and operation versions;
- exact execution ID and monotonic checkpoint generation;
- repository, profile, workspace, source commit/tree, and source digest;
- closed phase and state vocabularies;
- canonical start, observation, and terminal timestamps;
- bounded queue, reservation, heartbeat, progress, outcome counts, continuation barriers, deferred actions, and next action;
- opaque log/artifact references;
- coverage state;
- explicit false authority declarations.

Unknown fields fail closed. Filesystem paths, argv, commands, environment values, stdout, stderr, credentials, tokens, source bytes, arbitrary logs, and unrestricted prose stay outside the schema.

## Replay and conflict

`parseGlaedaReceiptIntake` validates the complete admitted public intake and computes its canonical fingerprint from the full validated attempt and receipt semantics. The returned transition remains a bounded projection, while fields omitted from that projection—such as detailed counts, continuation arrays, timestamps, and evidence references—still participate in exact replay identity.

`compareGlaedaReceiptTransitions` classifies one incoming checkpoint against the last durable transition:

- `insert` — first accepted checkpoint;
- `duplicate` — exact same checkpoint generation and complete validated semantic fingerprint;
- `advance` — exactly the next checkpoint generation, the same immutable execution identity, and an allowed state transition;
- `stale` — an older checkpoint generation;
- `conflict` — changed attempt/execution identity, reused checkpoint generation with different semantics, generation gap, candidate-head regression, terminal mutation, invalid state order, or observation-time reversal.

A different execution ID, producer version, operation family, or operation schema requires an explicit superseding Stensibly attempt or an admitted successor generation under its owning contract.

## Heartbeat and named waits

Only `starting`, `running`, and `verifying` receipts claim an active heartbeat. The legacy v1 interval is bounded to at most 60 seconds.

For active states, Stensibly projects `stalledAt` as the earlier of:

- three missed heartbeat intervals after the last durable observation; or
- the receipt's lease expiry.

`waiting_external` and `continuation_required` carry explicit next actions and remain separate from active executor liveness. Queue and reservation states remain separately visible.

## Current scope

This integration provides:

- strict legacy-v1 schemas under explicit SmolRunner-v1 labels;
- a current Glaeda-facing receipt parser;
- pure receipt-to-transition mapping;
- complete-semantic deterministic canonical fingerprints;
- replay/conflict classification with immutable producer/operation identity;
- pure liveness projection;
- historical progress and terminal fixtures;
- focused non-disclosure, generation-fence, semantic-replay, and rename-compatibility tests.

Database tables, event writers, REST/MCP endpoints, network clients, filesystem reads, background pollers, live Glaeda invocation, retry commands, handoff mutations, and fallback executors remain owned by their dedicated Stensibly contracts.
