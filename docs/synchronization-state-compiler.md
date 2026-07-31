# Synchronization state compiler

`src/synchronization-state.ts` defines the first pure reconciliation slice for campaign #744.

It compiles a bounded set of already-admitted facts from GitHub, ProofWake, and Stensibly into one current synchronization state, one closed conflict list, one safe next action, and deterministic input/projection fingerprints.

The compiler performs no provider request, persistence, command dispatch, claim, approval, authority transition, retry, merge, deployment, or user-interface mutation.

## Ownership boundary

The input facts remain owned by their source systems:

- GitHub facts describe an exact GitHub-owned subject revision and signed or reconciled source observation.
- ProofWake facts describe an accepted evidence projection and its declared source revision.
- Stensibly operation facts describe reserved, dispatched, ambiguous, or verified outbound work.
- Stensibly authority facts describe the exact authority generation used by coordination work.
- Stensibly coordination facts describe accepted, competing, or degraded coordination evidence.

The compiler joins these identities. It does not copy unrestricted provider payloads or decide facts owned by another source.

## Exact input

The versioned input contains:

- `schemaVersion: 1`;
- a policy version and canonical trusted `evaluatedAt` time;
- one exact GitHub subject identity and revision;
- at most one current GitHub source fact;
- at most one current ProofWake evidence fact;
- at most one current Stensibly outbound-operation fact;
- at most one current Stensibly authority fact;
- at most one current Stensibly coordination fact;
- zero or more explicit declared conflicts from an earlier reviewed admission boundary.

All retained identifiers use exact control-free bytes. Repository names use exact lowercase `owner/name`. Timestamps use canonical ISO bytes. Fingerprints use lowercase SHA-256 identities. Accessors, symbols, decorated or sparse arrays, unknown fields, future-dated facts, impossible operation settlement claims, and realistic credential values fail admission.

Exact objects compare every own property name, including non-enumerable properties, with the declared field set. Exact arrays admit only dense index properties plus the intrinsic non-enumerable `length` property. Hidden caller decorations therefore cannot influence execution while escaping the declared input envelope.

## Ordering and inference

The compiler does not infer chronology from ingestion time, array order, display order, prose, labels, or timestamps alone.

Declared conflicts are canonicalized by:

1. the closed conflict-priority order;
2. literal Unicode code-unit ordering of source owners and fact identities;
3. canonical JSON bytes.

Derived conflicts come only from direct contradictions or absent/freshness evidence in the admitted facts. Accepted history remains outside this current projection and is never rewritten by this compiler.

## Closed states

The compiler emits exactly one state:

- `synchronized` — complete current source, evidence, authority, and coordination facts agree; any operation is absent or verified;
- `pending_outbound` — an exact Stensibly operation is reserved or dispatched;
- `pending_reconciliation` — an outbound operation has an ambiguous provider outcome;
- `degraded` — current source coverage is missing;
- `stale` — admitted source or evidence facts exceeded their declared freshness window;
- `conflicted` — a hard identity, revision, readback, producer, authority, projection, or transition contradiction exists;
- `unknown` — no current facts exist or the admitted facts do not justify a stronger state.

State precedence is deterministic:

1. hard conflicts;
2. ambiguous outbound operation;
3. pending outbound operation;
4. stale facts;
5. missing coverage;
6. empty fact set;
7. complete agreement;
8. unknown.

## Closed conflicts

The initial vocabulary is:

- `delivery_identity_conflict`;
- `stale_source_observation`;
- `source_revision_divergence`;
- `ambiguous_outbound_operation`;
- `provider_readback_mismatch`;
- `competing_producer`;
- `missing_source_coverage`;
- `authority_generation_mismatch`;
- `projection_input_changed`;
- `unsupported_source_transition`.

Each conflict retains only its type, bounded fact identities, and source owners. The projection publishes one fixed next action selected by conflict priority. Provider prose, response bodies, logs, patches, prompts, and credentials stay outside the projection.

## Fingerprints

`inputFingerprint` covers the complete admitted input after canonical ordering.

`projectionFingerprint` covers the compiler revision, policy version, evaluation time, subject, derived state, conflict list, next action, bounded fact references, input fingerprint, and zero-authority fields.

Equivalent conflict sets produce identical fingerprints regardless of caller array ordering. Any admitted identity, freshness, revision, authority generation, operation state, coordination state, policy, or evaluation-time change rotates the projection fingerprint.

## Authority

Every projection fixes:

```text
authorizesMutation: false
authorizesAuthority: false
```

A synchronized projection does not authorize a GitHub write, Stensibly command, ProofWake receipt, claim, approval, merge, deployment, retry, or provider call. Those effects require their existing exact authority and operation contracts.

## Recovery and follow-up

Recovery is one squash revert because this slice is additive and pure.

Follow-up work may:

- consume real bounded accepted observation fixtures;
- append durable evaluation receipts through an existing Stensibly ledger boundary;
- compare successive projections and retain conflict clearing observations;
- add the compact operator projection from #571/#673;
- run the complete #490 dogfood lifecycle.

Those slices must preserve source ownership, append-only history, deterministic rebuilds, and the zero-authority rule for observational evidence.
