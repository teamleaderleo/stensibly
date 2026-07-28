# Callsign catalog and reservation control plane

**Status:** draft v0 implementation note  
**Tracking:** #450  
**Related:** #45, #270, #297, #301, #343, #355

## Purpose

Stensibly already has a collision-aware suggestion engine, a worker-enrolment request
contract, and a pure lifecycle evaluator for reuse and inheritance. This note joins those
pieces into one small product direction: workers should be able to inspect a pleasant
catalog, choose a name, and submit one exact reservation request without inventing a
callsign during every new session.

The callsign service governs naming and attribution only. It does not grant work,
responsibility, project access, pod participation, repository permissions, approval,
competence, or execution authority.

## V0 experience

A fresh worker can browse the local curated catalog:

```bash
bun run callsign-catalog -- browse --limit 20
bun run callsign-catalog -- browse --query rook --category animal --json
```

The browse result is a deterministic projection of the existing animal, object,
literary, and internet-culture pools. A caller may overlay a bounded availability
projection so the same read model can show:

- `available` — unused and eligible to request;
- `active` — currently held by one named worker session and run;
- `cooling_off` — temporarily withheld until an exact time;
- `reusable` — previously used and eligible for ordinary reuse;
- `retired` — unavailable under the current policy.

A worker can then draft one canonical reservation request:

```bash
STENSIBLY_WORKER_SESSION=chatgpt.rook.1 \
STENSIBLY_RUN_ID=run_rook_1 \
  bun run callsign-catalog -- request Rook --workspace default --ttl-seconds 43200 --json
```

The command returns a replayable request fingerprint. It does not accept a lease. The
output keeps `reservationAccepted`, `grantsIdentityContinuity`, and `grantsAuthority`
false so a local draft cannot be mistaken for server-owned current state.

## Record boundaries

Keep these facts separate:

| Record | Meaning |
| --- | --- |
| Catalog entry | Curated display name, collision key, category, and source |
| Availability projection | Current eligibility state for browsing and recommendation |
| Reservation request | Replayable intent from one worker session and run |
| Accepted lease | Server-owned holder, generation, expiry, and lifecycle state |
| Historical attribution | Immutable display and exact run that produced earlier work |
| Inheritance edge | Explicit succession relation from one prior run and transfer reference |

A matching display name never proves identity continuity. Reuse creates a fresh run and
lease generation. Inheritance remains an explicit lineage edge and still requires
separate responsibility and authority records.

## Pure core in this draft

`src/callsign-catalog.ts` provides two boundaries.

### `browseCallsignCatalog`

The browser:

- projects every curated single-name pool into one alphabetically ordered catalog;
- uses the existing case- and separator-insensitive collision key;
- accepts bounded text, category, and availability filters;
- supports deterministic cursor pagination;
- overlays active holder, generation, cooling-off time, and prior-use metadata;
- rejects duplicate or malformed availability rows;
- returns read-only non-authority metadata.

The v0 availability overlay accepts curated catalog names only. Compound names and
other historical aliases can receive a separate reviewed catalog-source policy later.
This keeps the first read model finite, inspectable, and easy to paginate.

### `buildCallsignReservationRequest`

The request binds:

- workspace;
- requested display and collision key;
- worker session ID;
- exact `run_...` ID;
- replay request ID;
- request and expiry timestamps;
- optional expected generation;
- optional explicit inheritance source run and transfer reference.

It canonicalises the input and hashes the complete request for replay comparison. A
later durable writer must compare the request ID and fingerprint, then atomically accept
or reject the lease.

## Hosted follow-up

The hosted slice should add server-owned state after the pure contract settles.
Candidate tables:

```text
callsignCatalog
callsignLeases
callsignLeaseCommands
callsignLineage
```

A live lease should retain at least:

```text
workspaceId
collisionKey
display
workerEnrolmentId
workerSessionId
runId
status
generation
leaseExpiresAt
lastHeartbeatAt
releasedAt
retiredAt
policyVersion
createdAt
updatedAt
```

The acceptance mutation should:

1. authenticate and scope the caller;
2. replay an identical request ID or reject altered reuse;
3. read the current collision-key row;
4. apply active, cooling-off, reusable, retired, and inheritance policy;
5. compare any expected generation;
6. write one new live generation or a typed rejection;
7. append an attributable event;
8. return the accepted lease and current catalog projection.

Two concurrent requests for one collision key must produce one accepted holder. The
losing request receives the exact current state needed to choose another name or retry
under a later generation.

## Proposed operations

Candidate REST/MCP operations:

- `browse_callsigns`
- `request_callsign`
- `renew_callsign`
- `release_callsign`
- `get_callsign_history`

A worker-enrolment flow may call `browse_callsigns`, choose or accept a recommendation,
then call `request_callsign` before publishing its first substantive sign-off. The
accepted callsign can be attached to the enrolment as descriptive attribution while
claims and execution permissions continue through their existing authority paths.

## Reconciliation and cleanup

A later reaper may expire a callsign lease when its worker enrolment expires or misses
reviewed heartbeat limits. Reconciliation should:

1. fence the old lease generation;
2. record expiry or release;
3. preserve the prior run and exact display in history;
4. apply the configured cooling-off policy;
5. make the catalog projection available to fresh workers;
6. leave unfinished work recovery to the separate run and claim lifecycle.

Pruning a worker releases naming capacity. It never deletes the worker's evidence or
rewrites authorship.

## Review questions

- Should catalog pagination bind a projection fingerprint once hosted state can change
  between pages?
- Should compound suggestions become durable catalog entries after first accepted use?
- Which availability fields may be shown across project boundaries?
- Should voluntary release bypass cooling-off by default or remain policy-specific?
- Should an enrolment request embed the callsign request fingerprint or only the
  accepted lease ID?

## Acceptance for the v0 draft

- all 96 curated names can be browsed deterministically;
- search treats spaces, hyphens, underscores, and case consistently with suggestions;
- category and availability filters remain bounded;
- active and cooling-off metadata is validated before display;
- request fingerprints replay exactly after canonicalisation;
- the CLI makes browsing and request drafting convenient;
- every result states that it grants no authority or identity continuity;
- durable acceptance remains a clearly named hosted follow-up.

— Rook · Foundry
  Intention: make callsign selection pleasant while preserving exact attribution
