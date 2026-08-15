# Broad mail selection → worker claim boundary

Refs #1525, #1510, #270, #306, #307, #1488, and #1493.

## Purpose

`MAIL-UX-SELECTION.md` ends at a deterministic recommendation. This page owns the next boundary: turning an explicitly accepted recommendation into one durable responsibility and one current-generation item claim without letting concurrent disposable workers both own the same work.

The selector stays pure and read-only. Gmail discovery, a message body, an STN handle, labels, unread state, subject text, thread identity, and `workerRef`/callsign all grant zero responsibility and zero authority.

## Join contract

A current-source adapter compiles one `WorkSelectionRecommendation` after the #1510 selection and fresh source reread. The recommendation binds:

```text
STN selection handle
project + exact item ID
item version
claim generation
priority + next action
current source fingerprint
responsibility role
optional independence key
work fingerprint
recommendation fingerprint
```

The recommendation carries `grantsResponsibility:false` and `grantsAuthority:false`.

An explicit acceptance request then calls the internal hosted mutation `workSelectionClaims:accept` with the authenticated owner identity, active `workerRef`, exact recommendation, lease duration, and idempotency key.

The mutation checks, in one Convex transaction:

1. exact acceptance replay/conflict identity;
2. current active worker enrolment ownership, expiry, and project scope;
3. current item status, item version, claim generation, and reproducible work fingerprint;
4. v0 WIP limit: one live item claim for this worker;
5. bounded review independence / implementation-review phase overlap;
6. only then creates the worker actor if needed, acquires the existing item claim, records a separate `responsibility.accepted` receipt/event with zero authority, and schedules the existing claim expiry.

The item claim remains the authority-bearing lease. The acceptance receipt is a separate responsibility fact and explicitly carries `grantsAuthority:false`.

## Race behavior

Two workers may hold the same recommendation bytes. Concurrent explicit acceptance is safe:

```text
A accept(snapshot N) ─┐
                     ├─ atomic item snapshot + claim transaction
B accept(snapshot N) ─┘

one -> accepted responsibility + claim generation N+1
one -> rejected/current refresh required; zero responsibility/claim effect
```

The loser must refresh current work and rerun deterministic selection. It cannot act from its old recommendation. A newly compiled recommendation for a different eligible item may then be accepted normally.

Exact command replay returns its original result. Reusing an idempotency identity with changed recommendation or lease bytes conflicts.

## Capacity and independence v0

#306 remains the owner of richer plate/capacity routing. This join implements the conservative admission needed for random disposable workers now:

- one live claimed item per worker;
- `general` work carries no independence key;
- `implementation` and `independent_review` carry one candidate/independence key;
- an independent reviewer cannot be a worker that previously accepted implementation responsibility for that key;
- live implementation and independent-review responsibility for the same key cannot overlap through this join.

These checks are admission fences. They do not turn recommendation into assignment.

## Worker disappearance and recovery

Worker enrolment expiry/release continues to invalidate `workerRef` admission. Existing item claim expiry/release remains the authority recovery mechanism. The join does not change renewal, release, completion, handoff, or claim-expiry behavior.

A responsibility acceptance receipt is historical evidence. Current authority is determined by the live item claim and claim generation.

## Live product boundary

The ChatGPT dogfood rule remains official Gmail + GitHub connectors only. Those surfaces can perform mailbox discovery and GitHub/current-source rereads, but this conversation has no approved official product action for invoking the hosted Stensibly `workSelectionClaims:accept` mutation without the quarantined developer connector.

Therefore live fresh-chat dogfood must stop at the recommendation/acceptance integration boundary. Server-side concurrency tests prove winner/loser behavior. A later approved product surface can expose explicit acceptance while preserving this exact contract; live dogfood must never reconnect the quarantined connector merely to demonstrate the claim.

## Inbox policy

Claim and acceptance mechanics emit no mail. They create no operator Inbox attention. Mail remains a rendezvous/selection surface; durable work ownership remains server-owned.
