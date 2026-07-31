# Runner cancellation settlement

Issue: #574

## Purpose

`RunnerAdapterV1.requestCancellation()` reports cancellation request and delivery facts, but its v1 observation deliberately fixes:

```text
remoteSettlementKnown: false
```

A successful method return therefore does not prove that the remote runtime, its tools, its streams, or its late publications have stopped. This coordinator applies the authoritative resource-settlement core to that exact boundary.

## Coordinator contract

`RunnerCancellationSettlementCoordinatorV1` is bound to:

- one adapter descriptor;
- one workspace and project;
- one exact cancellation command;
- one trusted observation clock.

The first `request()` starts one authoritative operation. Concurrent and later callers join the same promise. A caller may abandon its own wait with an `AbortSignal`; that does not cancel the adapter request or other waiters.

The adapter is called at most once.

## Admission

Before adapter activity, the coordinator exact-admits:

- descriptor cancellation support;
- command, adapter, profile, run, generation, and lease identity;
- the exact `run:<runId>` authority resource;
- authority generation and expiry at both request admission and the one trusted execution instant;
- one complete command fingerprint binding command, authority holder/expiry, and cancellation reason;
- canonical request time and bounded reason;
- lowercase workspace and project identity;
- credential-safe retained identifiers.

Objects must be plain own-data records. Accessors, custom prototypes, symbols, hidden fields, unknown fields, padded aliases, unsafe controls, and realistic credential-family values fail before adapter activity.

## Adapter evidence

Returned cancellation evidence and its optional external reference are re-admitted without invoking getters. They must match the accepted command and descriptor exactly.

The observation may state:

- whether the adapter accepted the cancellation request;
- whether delivery is known;
- one bounded external reference.

It may not claim remote settlement. Delivery cannot be known when the request was not accepted.

An external reference must be created no later than the cancellation observation that publishes it. Future-dated references fail as adapter evidence and contribute no successful output.

Malformed evidence, identity drift, adapter throws, and rejected references become the fixed outcome:

```text
adapter_failure
```

Raw exception text is not retained.

## Trusted clock failure

A started cancellation operation must still publish bounded recovery evidence when the trusted observation clock throws, returns a malformed timestamp, predates the accepted request, or predates retained adapter evidence.

In those cases the coordinator:

- discards the adapter observation;
- reports `adapter_failure`;
- uses the accepted request time as the deterministic settlement observation time;
- publishes the same reconciliation hold;
- retains no raw clock error text or contradictory external-reference digest.

The shared authoritative promise resolves with that bounded result rather than rejecting and stranding callers without a receipt.

## Settlement result

Every completed coordinator operation publishes one immutable `ResourceSettlementReceipt` for the exact run generation.

The settlement operation identity is the SHA-256 fingerprint of the complete admitted cancellation command. Reusing a command ID with different authority, expiry, or reason therefore produces a different receipt and result identity.

The adapter runtime owner is recorded as:

```text
state: reconciliation_required
failureClass: unknown_outcome
reconciliationRequired: true
canPublishLate: true
```

The aggregate disposition is `reconciliation_hold`. The receipt is terminal as an observation of the cancellation attempt, but it does not declare the remote runtime settled.

If the adapter returns a credential-safe reference with a SHA-256 digest, that digest remains visible in `successfulOutputs` even though aggregate settlement requires reconciliation.

`evaluateResourceGenerationAdvance()` is evaluated for the exact next generation and must return:

```text
allowed: false
reason: reconciliation_still_required
```

## Authority boundary

The coordinator adds no:

- durable run transition;
- remote cancellation implementation;
- retry or replay authority;
- late-publication fence;
- persistence;
- provider call;
- workflow or deployment change;
- public MCP or REST action.

A later reconciliation path may replace the hold only with provider-backed settlement evidence or an exact late-publication fence. The cancellation observation alone is never enough.

## Recovery

Before integration, close the additive pull request. After integration, revert the squash commit. Existing runner adapters and durable run state remain unchanged.
