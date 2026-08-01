# Execution certainty core

The execution-certainty core records what Stensibly can prove about one bounded
operation after a local execution path returns, fails, times out, or loses its
result. It does not dispatch work, call a provider, authorize replay, or apply a
durable transition.

## Why this exists

A local failure is not one fact. Stensibly must keep these questions separate:

- Was dispatch definitely not started?
- Was a remote response received?
- Could a mutation still be running or already committed?
- Was cancellation merely requested, delivered, or observed remotely?
- Is exact reconciliation still required?
- Is replay authorized?

The answer to the last question is always `not_authorized` in version one.

## Receipt states

`ExecutionCertaintyReceipt` derives one closed state from admitted evidence:

| State | Meaning |
| --- | --- |
| `not_dispatched` | This execution path proves dispatch never began. |
| `remote_result_received` | A bounded remote success or application-error response was received. |
| `local_failure_unclassified` | Dispatch may have begun, but the local failure does not prove the remote effect. |
| `local_timeout_outcome_unknown` | A timeout occurred after possible dispatch; the operation may still run or may have committed. |

Cancellation delivery never proves rollback. A result-serialization failure
never proves that the provider did not complete the operation.

## Evidence boundary

A receipt binds:

- workspace and project;
- execution path;
- operation name, kind, and stable reference;
- exact request and authority fingerprints;
- run generation;
- canonical observation time;
- dispatch and cancellation state;
- optional bounded remote-result identity;
- one closed local-failure class.

It retains no arguments, provider bodies, error text, prompts, item content,
URLs, credentials, tokens, or unrestricted diagnostics.

## Exact admission

Every public creator and parser captures one own-property descriptor snapshot
for every input record. Only ordinary or null-prototype records with enumerable
data properties are admitted. Accessors, symbols, hidden fields, inherited or
custom records, and unknown fields fail without invoking getters.

Workspace, project, operation, reference, and retained result identities are
accepted only in their exact spelling. The core does not trim or case-normalize
aliases. Timestamps use exact UTC millisecond spelling. Realistic GitHub,
Stensibly, OpenAI, Slack, secret-reference, and JWT credential families are
rejected from retained identifiers while benign identifiers such as
`task-sk-review` remain valid.

## Reconciliation

Only uncertain non-read operations require reconciliation. A second immutable
record binds the original receipt fingerprint to one later evidence source:

- `operation_receipt`;
- `provider_state`;
- `remote_result`.

Closed outcomes are:

- `effect_recorded`;
- `effect_absent`;
- `remote_result_recovered`;
- `still_unknown`.

Recovered remote results require the `remote_result` source. Other provider or
operation-receipt evidence cannot claim a recovered response. The rule is
exclusive: `remote_result` evidence must resolve as `remote_result_recovered`
and cannot report a recorded or absent effect. Reconciliation cannot precede
the original observation.

A resolved or still-unknown record also retains
`replayAuthorization: not_authorized`. When a caller parses a reconciliation
record with its originating receipt, the parser rechecks the receipt fingerprint,
operation identity, request and authority fingerprints, run generation, and
chronology. A caller must use a separately reviewed retry or recovery policy;
this module never grants one.

## Integrity and recovery

Receipts and reconciliation records are deeply frozen. Their derived
projections and SHA-256 fingerprints are recomputed during parsing, so callers
cannot alter certainty, resolution, or replay status independently from the
admitted evidence.

The module is behavior-neutral and additive. Recovery is deletion before
integration or revert of its eventual squash commit. No persistence, provider
request, public MCP action, cancellation transport, deployment, dependency, or
credential handling is included.
