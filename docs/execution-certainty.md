# Execution certainty contract

This document defines the first behavior-neutral execution-certainty contract for issue #572.
It preserves what Stensibly actually knows about dispatch and settlement without changing
public MCP results, authorizing retry, or claiming that a local failure stopped a remote effect.

The implementation lives in `src/execution-certainty.ts`.

## Problem

A local caller can report timeout, cancellation, serialization failure, transport failure, or a
generic failed tool result while a provider or server operation is still running or has already
committed. Conversely, local schema, policy, approval, binding, and generation checks can prove
that dispatch never began.

Those observations must not collapse into one `failed` state.

## Initial certainty states

### `not_dispatched`

The call path proved that remote or provider execution did not begin. Examples include local
argument rejection, missing binding, policy denial, approval decline, preparation failure, or a
generation mismatch detected before dispatch.

This state says only that this exact call path did not execute. It does not authorize replay of an
old call identity.

### `remote_result_received`

A remote or provider result was received. Both successful results and application-level error
results belong here. An application-level error can still be the terminal result of an executed
operation.

### `local_failure_unclassified`

A local, transport, or delivery-layer failure occurred after dispatch may have begun, but the
available evidence does not prove remote settlement. Result serialization failure is included:
the operation can complete before its public result fails to serialize.

### `local_timeout_outcome_unknown`

The active local deadline elapsed after dispatch may have begun. The remote operation may still be
running or may already have committed. Cancellation request, delivery, or remote observation does
not by itself prove non-execution or rollback.

## Immutable evidence

One receipt binds only bounded server-owned facts:

- workspace and project;
- execution path;
- operation name and operation kind;
- server-generated operation reference;
- exact request fingerprint;
- exact authority fingerprint;
- run generation;
- canonical UTC observation time;
- dispatch state;
- cancellation evidence;
- optional bounded remote-result identity and outcome;
- optional closed local-failure class.

It contains no request arguments, provider payload, output body, error text, credential, token,
authorization header, prompt, item content, URL, or unrestricted diagnostic object.

Every object rejects unknown fields. Receipt fingerprints cover both the immutable evidence and the
derived certainty projection. Parsing recomputes the projection and fingerprint rather than trusting
stored derived fields.

## Evidence is not retry policy

Every first-version receipt carries:

```text
replayAuthorization: not_authorized
```

This remains true for known pre-dispatch failure, timeout, transport failure, serialization failure,
remote success, and remote application error. A later policy may permit a newly sampled or exact
idempotent operation, but this evidence contract never grants that authority.

Potential mutation, mixed, or unknown operations with unconfirmed settlement require an operation
receipt or exact provider-state read. Declared read-only paths do not require mutation-state
reconciliation, but this contract still does not authorize retry.

## Reconciliation

Reconciliation is a second immutable record linked to the original receipt fingerprint. It can record:

- an effect found in a durable operation receipt;
- an effect found in exact provider state;
- exact evidence that the effect is absent;
- a recovered remote result;
- or continued uncertainty.

A resolution record preserves the original operation, request, authority, and generation identities.
It never rewrites the original timeout or failure into a different historical observation.

Even a resolved-absent record carries `replayAuthorization: not_authorized`. Any new operation still
requires current authority, current generation, and its own request identity.

## Contradictions rejected

The contract rejects combinations such as:

- a received remote result without started dispatch;
- a received remote result plus a local failure class;
- a tools-call timeout before dispatch;
- remote cancellation delivery before dispatch;
- a known pre-dispatch failure after dispatch;
- result serialization failure without completed local dispatch;
- malformed SHA-256 identities;
- loose, offset, impossible, or non-UTC timestamps;
- derived certainty or fingerprints that do not match the evidence;
- remote-result recovery attributed to provider-state evidence;
- reconciliation that predates the original observation.

## Current fence

This slice does not:

- persist receipts in SQLite or Convex;
- change `get_operation_receipt`;
- change public/model-visible MCP output;
- classify arbitrary formatted error strings;
- add cancellation transport behavior;
- authorize retry, fallback, reconnect, or provider mutation;
- infer idempotency or safety from MCP annotations;
- read provider state.

The next slice should thread this type through one mutation path while keeping public output compatible,
then persist the bounded receipt beside the existing idempotency/operation receipt and reconcile one
lost-result case without replay.
