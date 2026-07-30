# Resource settlement core

Issue: #574

## Purpose

A public `closed`, `failed`, `cancelled`, or `complete` flag does not prove that every owned transport, worker, task, lease, artifact, or provider resource has settled.

This core separates admission closure from authoritative terminal settlement.

```text
open
closing
settled_success
settled_failure
```

The module is pure and provider-free. It adds no persistence, runner mutation, cancellation transport, retry, deployment, or external authority.

## Joinable authoritative operation

`AuthoritativeSettlementController` owns one completion promise.

- the first `start()` closes admission and creates the completion;
- concurrent and later `start()` calls receive the same promise;
- a waiter may abandon its own wait through an `AbortSignal` without cancelling the authoritative operation;
- success and failure become terminal only when that shared completion settles;
- admission never reopens implicitly.

The controller does not decide which children to close or whether a failed operation is safe to retry. Those decisions belong to an adapter and an accepted settlement receipt.

## Owner records

A receipt contains at most 500 canonical owner records. Each record binds:

- owner ID, kind, and generation;
- whether settlement was attempted;
- attempted and settled timestamps;
- one closed settlement state;
- a bounded failure class when applicable;
- reconciliation state;
- whether late publication was possible;
- successful output identity when one exists;
- an exact publication-fence fingerprint when late effects were fenced.

Owner states are:

- `pending`;
- `settled_success`;
- `settled_failure`;
- `reconciliation_required`;
- `publication_fenced`.

A failed owner may retain an output fingerprint. This covers cases such as an artifact becoming durable before later cleanup fails. Aggregate failure must not erase successful output identity.

## Aggregate phase

The aggregate phase is derived rather than supplied.

- `open` requires open admission, no closing timestamp, no terminal disposition, and no attempted owner;
- `closing` requires closed admission and at least one pending owner;
- `settled_success` requires every owner terminal without failure or reconciliation evidence;
- `settled_failure` requires every owner represented by a terminal success, failure, reconciliation, or exact publication-fence record, with at least one non-success state.

A terminal timestamp must not precede closing or any owner settlement evidence.

`continue_through_error` and `stop_after_failure` are explicit policies. Stop-after-failure is validated by timestamps, not canonical owner ordering: no new owner attempt may begin after the first failure settles.

## Generation advancement

`evaluateResourceGenerationAdvance()` is fail closed.

A replacement generation requires:

1. the exact next generation number;
2. terminal aggregate settlement;
3. no owner still requiring reconciliation;
4. no aggregate `reconciliation_hold` disposition.

A `publication_fenced` owner may permit advancement because the receipt binds an exact fence that rejects late effects. An unfenced unknown owner remains `reconciliation_required` and blocks advancement.

The decision does not start a generation or grant runner authority.

## Privacy and authority

Receipts retain only bounded identifiers, canonical UTC timestamps, closed state/failure vocabularies, counts, SHA-256 output/fence identities, and derived owner keys.

They exclude:

- credentials and tokens;
- request or provider payload bodies;
- prompts, item text, artifact bodies, and error messages;
- arbitrary diagnostic objects;
- provider execution or retry authority.

Every receipt contains:

```text
settlementRetryAuthorization: not_authorized
```

Retry after partial failure requires a separate policy that identifies incomplete owners and reconciles prior effects.

## First integration boundary

The next #574 slice should adapt one runner stop or interrupt path:

- create one controller per exact runner generation;
- reject new admission once closing starts;
- continue or stop owner cleanup according to a declared policy;
- create the canonical receipt from observed child outcomes;
- retain successful artifacts in mixed failure;
- require `evaluateResourceGenerationAdvance()` before publishing a replacement generation.

Direct, hosted, and runner-adapter implementations should consume the same receipt contract rather than recreating lifecycle semantics independently.
