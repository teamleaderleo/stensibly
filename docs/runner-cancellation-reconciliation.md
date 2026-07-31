# Runner cancellation reconciliation

Issue: #574

## Purpose

The landed cancellation coordinator always produces a reconciliation hold because `RunnerCancellationObservationV1` cannot prove remote settlement. This pure compiler consumes that exact prior result plus one attributable reconciliation receipt and decides whether the prior run generation may be released.

It performs no provider read itself.

## Evidence kinds

The compiler accepts one closed evidence kind:

- `provider_settled` — an attributable provider receipt proves the prior runtime has settled;
- `provider_still_running` — the provider still reports live work;
- `provider_unknown` — the provider observation remains inconclusive;
- `publication_fence` — an exact fence rejects late prior-generation publication.

Every path requires a credential-safe `provider_receipt` reference with:

- the same adapter identity;
- the exact prior run generation;
- a SHA-256 digest;
- a creation time between the original settlement and reconciliation observation;
- no private content or credentials;
- one canonical external identity for the declared evidence kind.

Canonical external identities are:

```text
remote-settlement:<runId>:g<generation>
runtime-still-running:<runId>:g<generation>
runtime-unknown:<runId>:g<generation>
publication-fence:<runId>:g<generation>
```

A receipt for one evidence kind cannot be reused as another kind.

The publication-fence path additionally requires one exact SHA-256 fence fingerprint that is byte-for-byte equal to the `publication-fence` receipt digest. A valid receipt combined with an unrelated fence value is rejected. Provider-read paths cannot carry a fence fingerprint.

## Prior result admission

The prior `RunnerCancellationSettlementResultV1` v2 result is re-admitted before reconciliation.

The compiler verifies:

- the complete result fingerprint;
- workspace, project, command, public command fingerprint, adapter, version, profile, run, run generation, and lease generation;
- the exact nested cancellation observation when present;
- cancellation identity, chronology, delivery rules, `remoteSettlementKnown: false`, and optional reference admission;
- the original reconciliation-held settlement receipt under policy `runner-cancellation-settlement-v2`;
- exact equality between the retained `commandFingerprint` and settlement `operationRef`;
- the one exact adapter owner and output-reference digest;
- the derived blocked generation-advance decision;
- private-content and credential exclusion.

The public command ID cannot replace the command-bound settlement operation fingerprint. A caller also cannot substitute a different valid SHA-256 value and recompute only the outer result fingerprint: the v2 receipt must carry that same exact digest.

A caller cannot alter nested cancellation evidence and merely recompute the outer result fingerprint. The nested observation is parsed and bound independently before fingerprint comparison.

Objects and arrays are recursively copied through a bounded JSON-data admission layer. Accessors, custom prototypes, symbols, hidden fields, sparse/decorated arrays, non-finite numbers, excessive depth, and excessive size fail without getter execution. Own fields such as `__proto__` remain own data on a null-prototype copy and therefore reach exact unknown-field rejection.

## Reconciled settlement

### Provider-settled

The prior generation becomes `retired`. Its adapter owner becomes:

```text
state: settled_failure
failureClass: cancelled
reconciliationRequired: false
canPublishLate: false
```

The `remote-settlement` receipt digest remains a successful output identity. The exact next generation is allowed.

### Publication-fenced

The prior generation becomes `retired`. Its adapter owner becomes:

```text
state: publication_fenced
failureClass: unknown_outcome
reconciliationRequired: false
canPublishLate: true
publicationFenceFingerprint: <receipt-bound SHA-256>
```

The exact next generation is allowed because the settlement receipt binds the same digest carried by the canonical `publication-fence` evidence receipt.

### Still running or unknown

The prior generation remains under `reconciliation_hold` with:

```text
state: reconciliation_required
failureClass: unknown_outcome
reconciliationRequired: true
canPublishLate: true
```

The exact next generation remains blocked.

## Authority boundary

The compiler does not:

- contact a provider;
- attest that a provider receipt is authentic;
- create or enforce a publication fence;
- change durable run state;
- dispatch cancellation;
- authorize retry or replay;
- persist evidence;
- expose a public MCP or REST action;
- modify a runner adapter, workflow, dependency, or deployment.

A trusted caller must obtain the provider receipt or fence evidence through a separate bounded authority path. This compiler exact-admits and composes that evidence with the original cancellation receipt; it cannot turn an unauthenticated caller assertion into provider truth.

## Recovery

Before integration, close the additive pull request. After integration, revert the squash commit. The landed cancellation coordinator and all adapters remain unchanged.
