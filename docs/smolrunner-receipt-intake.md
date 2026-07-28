# SmolRunner receipt intake boundary

This document defines the first Stensibly-side contract for the SmolRunner pilot in issue #260.

The boundary is deliberately transport-neutral and consume-only. Stensibly accepts a versioned, content-minimised JSON receipt produced by SmolRunner. It does **not** import the SmolRunner crate, link through FFI, invoke the pure Rust mapper as an internal subprocess API, inspect the durable journal, or infer execution from pull-request comments, reactions, branch movement, or silence.

## Ownership split

Stensibly remains authoritative for:

- workspace, project, item, claim generation, run generation, and lease generation;
- the execution-envelope version and approved runner/verification profiles;
- durable attempt state, replay, conflict, stall, retry, handoff, fallback, and next action;
- deciding whether a receipt belongs to the current attempt;
- preserving repository, base, candidate-head, workspace-receipt, and authority-policy identity.

SmolRunner remains authoritative for:

- queue and reservation evidence;
- runner/workspace preparation and resource enforcement;
- exact execution and checkpoint identity;
- heartbeat and lease evidence while the executor is actually active;
- bounded progress, continuation barriers, terminal outcome, cleanup, and public receipt evidence;
- converting private runtime state into the documented public receipt.

Neither side gains merge, deployment, credential, spending, or provider-administration authority through this contract.

## Intake identity

Every intake binds the public receipt to an exact Stensibly attempt:

- `attemptId`;
- workspace, project, and item IDs;
- exact claim, run, and lease generations;
- exact execution-envelope version;
- executor adapter `smolrunner`;
- approved runner profile;
- canonical lower-case `owner/repository` identity;
- requested base and immutable resolved base commit;
- current published candidate head, when one exists;
- approved verification profile;
- opaque SmolRunner workspace receipt reference.

The receipt must repeat the envelope version, repository, runner profile, verification profile, workspace receipt, and exact source commit. Cross-boundary drift fails validation.

Candidate heads are not treated as immutable attempt identity. A later checkpoint may publish a new exact head. Replaying the same checkpoint generation with different head or other semantics conflicts, and a later checkpoint may not regress from a known head to `null`.

Within one execution ID, the producer version and operation family/schema are immutable. A later checkpoint that changes any of those fields conflicts as changed execution identity.

## Public receipt limits

The accepted receipt contains only bounded machine fields:

- producer and operation versions;
- exact execution ID and monotonic checkpoint generation;
- repository, profile, workspace, source commit/tree, and source digest;
- closed phase and state vocabularies;
- canonical start, observation, and terminal timestamps;
- bounded queue, reservation, heartbeat, progress, outcome counts, continuation barriers, deferred actions, and next action;
- opaque log/artifact references;
- coverage state;
- explicit false authority declarations.

Unknown fields fail closed. Filesystem paths, argv, commands, environment values, stdout, stderr, credentials, tokens, source bytes, arbitrary logs, and unrestricted prose are not part of the schema.

## Replay and conflict

`parseSmolRunnerReceiptIntake` validates the complete public intake and computes its canonical fingerprint from the full validated attempt and receipt semantics. The returned transition remains a bounded projection, while fields omitted from that projection—such as detailed counts, continuation arrays, timestamps, and evidence references—still participate in exact replay identity.

`compareSmolRunnerReceiptTransitions` classifies one incoming checkpoint against the last durable transition:

- `insert` — first accepted checkpoint;
- `duplicate` — exact same checkpoint generation and complete validated semantic fingerprint;
- `advance` — exactly the next checkpoint generation, the same immutable execution identity, and an allowed state transition;
- `stale` — an older checkpoint generation;
- `conflict` — changed attempt/execution identity, reused checkpoint generation with different semantics, generation gap, candidate-head regression, terminal mutation, invalid state order, or observation-time reversal.

A different execution ID, producer version, or operation family/schema is not an implicit fallback. Fallback or handoff must create an explicitly superseding Stensibly attempt while preserving the reviewed repository/base/head/profile/workspace identity required by policy.

## Heartbeat and named waits

Only `starting`, `running`, and `verifying` receipts claim an active heartbeat. The pilot interval is bounded to at most 60 seconds.

For active states, Stensibly projects `stalledAt` as the earlier of:

- three missed heartbeat intervals after the last durable observation; or
- the receipt's lease expiry.

`waiting_external` and `continuation_required` carry explicit next actions and do not pretend the executor is still actively working. They do not become stalled merely because no runner heartbeat arrives. Queue and reservation states remain separately visible.

## Current scope

This slice provides:

- strict schemas;
- pure receipt-to-transition mapping;
- complete-semantic deterministic canonical fingerprints;
- replay/conflict classification with immutable producer/operation identity;
- pure liveness projection;
- progress and terminal fixtures;
- focused non-disclosure, generation-fence, and semantic-replay tests.

It adds no database table, event writer, REST/MCP endpoint, network client, filesystem read, background poller, live SmolRunner invocation, retry command, handoff mutation, or fallback executor. Those belong in later reviewed slices after SmolRunner freezes its public receipt schema and the Stensibly durable attempt store is selected.
