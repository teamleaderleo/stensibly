# Durable tool capability grant admission

Issue #453 requires server-owned authority between an agent proposal and any consequential tool call. The pure evaluator in `src/tool-capability-grant.ts` defines exact requests, grants, approvals, fingerprints, and bounded authorization decisions.

This slice adds SQLite-backed acceptance, revocation, atomic use reservation, and admission history. It still performs no provider action and resolves no credential.

## Boundary

The flow is:

```text
reviewed grant proposal
  → append-only accepted grant
  → server-owned current generation and fingerprint
  → exact typed request
  → revocation and use-count lookup
  → pure authorization evaluation
  → atomic use reservation
  → bounded authorized or denied admission record
  → later executor boundary
```

The caller never supplies the trusted grant fingerprint used for authorization. The admission transaction reads the current accepted grant from SQLite and supplies its stored fingerprint to the pure evaluator.

Assignment, issue text, model identity, callsign, repository instructions, and an arbitrary grant object remain untrusted until one exact grant is accepted into server-owned state.

## Accepted grants

`acceptSqliteToolCapabilityGrant()` accepts only grants that:

- have a valid canonical fingerprint;
- are immutable and contain no embedded revocation;
- match the explicit workspace and project storage scope;
- use a positive generation;
- preserve actor, worker session, and run across higher generations.

Revocation is stored separately so the accepted grant fingerprint remains immutable as the trust anchor.

Acceptance is append-only and generation-fenced:

- the first generation requires `expectedCurrentGeneration: null`;
- a higher generation requires the exact current generation;
- exact acceptance replay returns the existing record;
- reuse of one acceptance reference with altered content conflicts;
- reuse of one grant ID and generation with another fingerprint conflicts;
- stale or non-increasing generations conflict;
- a higher generation transaction clears the previous current flag and installs one new current record.

Historical generations remain readable and retain their original accepted fingerprint, actor, evidence, and permission set.

## Revocation

`revokeSqliteToolCapabilityGrant()` records one append-only revocation for one exact current grant generation and fingerprint.

A revocation binds:

- workspace and project;
- grant ID and generation;
- exact accepted grant fingerprint;
- effective UTC time within the grant lifetime;
- revoking actor;
- bounded reason code;
- idempotency key.

Exact replay returns the original record. Altered idempotency reuse, another revocation for the same generation, a stale fingerprint, or an out-of-lifetime effective time fails closed.

A future revocation does not deny requests before its effective time. At or after that time, admission records `grant_revoked` without consuming another use.

This slice does not yet terminate active runs or invalidate derived credentials. Those remain later executor and run-control work.

## Atomic admission and use reservation

`reserveSqliteToolCapabilityUse()` accepts:

- workspace and project;
- grant ID;
- expected generation;
- current UTC time;
- one typed `ToolCapabilityRequestInput`;
- one idempotency key.

Before the transaction begins, the typed request builder validates and canonicalizes the request. Raw malformed objects, unsafe paths, secret-looking values, shell fields, or invalid URLs fail at that boundary and are not retained.

Inside one SQLite transaction the ledger:

1. checks exact idempotency replay;
2. loads the current accepted grant and server-owned fingerprint;
3. checks an effective revocation;
4. loads current per-permission use counts;
5. calls the pure evaluator;
6. atomically increments the authorized permission use once;
7. records a bounded authorization or denial result.

The admission API does not accept a trusted fingerprint argument. It cannot be persuaded to authorize a self-minted grant by copying a digest into a tool request.

The use row is scoped by workspace, project, grant ID, generation, accepted fingerprint, and permission ID. A superseding generation therefore begins with an independent use budget.

High-impact permissions remain one-shot because the pure grant builder requires `maxUses: 1` for merge, deployment execution, credential use, external messages, destructive deletion, and spend commitment.

## Idempotency

An admission attempt fingerprint binds:

- workspace and project;
- grant ID;
- expected generation;
- canonical authorization time;
- exact request fingerprint.

Repeating the same idempotency key and attempt returns the original admission record and does not consume another use. Reusing the key with changed time, generation, grant, subject, resource, action, or arguments conflicts before use consumption.

The stored admission contains no exact request arguments. It retains only:

- the attempt and request fingerprints;
- accepted grant generation and fingerprint, when one existed;
- the bounded pure authorization result;
- record identity and time.

An authorization result contains the permission ID, resource key, approval ID, expiry, and remaining uses, or one bounded denial reason. It does not contain credentials or request arguments.

## Denial behavior

Valid typed requests receive durable denials for conditions including:

- no accepted current grant;
- generation mismatch;
- grant expiry or not-yet-active state;
- effective revocation;
- subject, action, resource, or argument mismatch;
- approval state or expiry;
- exhausted permission budget.

No accepted grant is recorded as `grant_untrusted`. Denied attempts never increment a use counter.

## Integrity and isolation

Every table is explicitly scoped by workspace and project. Grant IDs, generations, acceptance references, revocation idempotency keys, and admission idempotency keys are unique only inside that scope.

Reads validate:

- canonical grant fingerprints and duplicated row metadata;
- revocation field syntax and timestamps;
- authorization JSON fingerprints;
- authorization grant and request identities.

Tampered stored grants or admission results throw rather than producing plausible-looking authority.

SHA-256 fingerprints are deterministic identities and integrity checks, not signatures. Trust comes from the server-owned accepted row and transaction, not from the digest alone.

## API surface

```ts
ensureToolCapabilityGrantSchema(store)
acceptSqliteToolCapabilityGrant(store, input)
getCurrentSqliteToolCapabilityGrant(store, scope)
listSqliteToolCapabilityGrantHistory(store, scope)
revokeSqliteToolCapabilityGrant(store, input)
getSqliteToolCapabilityRevocation(store, scope)
reserveSqliteToolCapabilityUse(store, input)
getSqliteToolCapabilityPermissionUsage(store, scope)
listSqliteToolCapabilityAdmissions(store, scope)
```

## Non-goals

This slice performs no:

- provider or external-system call;
- credential-handle resolution or secret injection;
- OAuth operation;
- REST, MCP, dashboard, or Convex projection;
- merge, deployment, message, deletion, spend, or other real-world effect;
- provider receipt or effect reconciliation;
- active-run termination;
- domain, process, file, wall-time, or cumulative spend budgeting;
- automatic grant issuance from model output, assignment, or repository text.

An authorized admission is a consumed reservation for a later executor. It is not proof that an external effect occurred.

## Next boundary

A later separately reviewed executor slice should consume one authorized admission ID, verify it has not already produced a receipt, resolve only the typed resource and opaque credential handles permitted by that admission, execute one provider operation, and append an idempotent receipt or ambiguity record.

REST/MCP inspection and dashboard visibility can expose content-minimised accepted grants, revocations, use counts, and admissions without exposing exact arguments, fingerprints beyond necessary operator evidence, or secret material.
