# Exact tool capability grants

Issue #453 defines Stensibly's authority boundary between an agent proposal and a consequential tool call. This document describes the first repository-native slice implemented by `src/tool-capability-grant.ts`.

## What this slice does

The pure core creates and evaluates two canonical records:

1. **Tool capability request** — one exact subject, action, typed resource, and canonical argument object.
2. **Tool capability grant** — one short-lived, generation-fenced set of exact requests issued to one actor, worker session, and run.

A successful evaluation means only that the supplied request matches a current grant. The evaluator does not execute a tool, inject credentials, persist use counters, consume a use, approve an effect, or contact a provider.

## Exact request binding

Every request binds:

- workspace and project;
- actor, worker session, and run;
- one action;
- one typed resource;
- one canonical JSON argument object;
- an argument fingerprint and whole-request fingerprint.

Object keys are sorted before fingerprinting, so equivalent key ordering produces the same request. Any changed action, resource, argument, subject, or run produces a different request and requires another authorization decision.

### Typed resources

The first slice supports bounded resource forms for:

- GitHub repositories;
- GitHub branch prefixes;
- exact GitHub pull requests at one head SHA;
- Stensibly projects;
- deployment environments at one source SHA;
- opaque credential handles;
- opaque external-recipient references;
- exact resource records;
- spend budgets expressed as currency and maximum minor units.

Actions and resource kinds are paired. Constraint-bearing arguments are also checked against the typed resource: branch names must stay inside the authorized prefix, branch bases must be full SHAs, artifact targets must match the request workspace/project, merge arguments must preserve the exact authorized PR head, and spend amount/currency must remain within the typed budget. A request cannot turn branch authority into merge authority—or a narrow resource into a broader one—through free-form arguments.

## Argument safety

Arguments are bounded canonical JSON. The builder rejects:

- cycles, non-JSON values, custom object prototypes, excessive depth, size, keys, or array entries;
- prototype-pollution keys;
- control and bidirectional text controls;
- raw secret-looking values;
- secret or executable fields unless they are opaque references such as an ID, ref, or handle;
- absolute, backslash-based, or `..`-traversing paths;
- non-HTTPS or credential/query/fragment-bearing URLs.

This is a defence-in-depth boundary. Each actual executor must still validate its own typed schema and provider-specific invariants.

## Grant lifetime and fencing

A grant binds:

- one workspace, project, actor, worker session, and run;
- one positive generation;
- an issuer and authority reference;
- at least one evidence reference;
- one to 32 exact permissions;
- at most a one-hour lifetime;
- an optional bounded revocation record.

The evaluator fails closed when the grant is not active, expired, revoked, altered after fingerprinting, presented with a stale expected generation, or not matched by the trusted grant fingerprint supplied from server-owned storage.

## Trust anchor and fingerprints

The record fingerprint is an integrity and replay identifier, **not a signature**. Anyone who can construct a record can also compute a SHA-256 digest. Authorization therefore requires a `trustedGrantFingerprint` obtained from the server-owned accepted-grant record. The executor must supply that value from authoritative storage; it must never accept it from model output or tool-call arguments.

A self-minted grant, or a canonical grant copied from another store, fails with `grant_untrusted` even when its internal digest is valid. The expected generation is likewise supplied from current server state rather than from the requesting model.

## Uses and atomic consumption

Each permission has a maximum use count. The evaluator accepts the currently persisted usage count and reports whether the request is eligible plus the remaining count after authorization.

The pure evaluator does **not** increment the counter. A durable executor must atomically:

1. read the current grant generation, state, approval, and use count;
2. evaluate the exact request;
3. reserve or increment one use with compare-and-set semantics;
4. execute only after that durable consumption succeeds;
5. record the outcome and any provider receipt.

Without that transaction, two concurrent callers could both observe the same remaining use.

## Human approval

High-impact actions currently include merge, deployment execution, credential use, external messages, destructive deletion, and spend commitment.

Those permissions require an approval record whose binding fingerprint covers the grant ID, grant generation, permission ID, and full request fingerprint. Pending, rejected, expired, argument-mismatched, permission-mismatched, or generation-replayed approvals fail closed. Approval does not replace the grant: subject, generation, lifetime, resource, arguments, revocation, and budget checks still apply.

Low-impact permissions cannot carry decorative approval records. This prevents unrelated approval text from being mistaken for authorization.

## Secret handling

The request and grant contracts prohibit raw secret material. Credential access is represented only by an opaque `credential_handle` resource.

A later protected executor may resolve that handle after authorization. It must never copy the resolved credential into model context, event payloads, dashboard projections, logs, fingerprints, or retained artifacts.

## Bounded projection

`projectToolCapabilityGrant()` exposes a dashboard/event-safe summary:

- grant subject, generation, issuer, evidence, lifetime, and current state;
- permission action and typed resource key;
- approval state;
- maximum, used, and remaining use counts.

It deliberately omits exact arguments, argument fingerprints, request fingerprints, and secret values.

## Follow-up hosted boundary

A later reviewed slice should add:

- append-only grant and revocation storage whose accepted fingerprint is the authorization trust anchor;
- generation-fenced issuance under current project/run authority;
- atomic use consumption and idempotent execution receipts;
- approval-token persistence bound to exact request fingerprints;
- credential-handle resolution inside protected execution surfaces;
- MCP/REST request and inspection tools;
- dashboard views for current, pending, denied, expired, and revoked grants;
- active-run termination or reconciliation after revocation;
- domain, process, file, wall-clock, and spend budgets;
- adversarial executor tests against prompt injection and data exfiltration.

The hosted layer must treat this pure evaluator as necessary but not sufficient. Assignment, callsign, model identity, repository text, and an issue comment remain descriptive inputs; none of them independently creates a valid grant.


## Version 1 canonical ordering

Version 1 fingerprints sort every security-relevant object key, evidence reference,
and permission identifier with direct UTF-16 code-unit comparison:
`left < right ? -1 : left > right ? 1 : 0`.

Locale-aware collation is excluded from the fingerprint contract. Runtime locale,
ICU data, operating-system configuration, and future collation upgrades therefore
cannot change the canonical byte sequence or SHA-256 identity for equivalent input.
