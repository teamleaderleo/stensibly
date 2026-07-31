# Task-scoped assurance overlay contract

Tracking: #510.

## Purpose

An assurance overlay is expiring, task-specific guidance for one exact execution context. It can require checks, stop conditions, and review policy. It never grants operation, provider, merge, deployment, approval, credential, or canonical-write authority.

The contract is pure and deterministic. It adds no loader, persistence, prompt injection, provider call, public action, or live overlay registration.

## Overlay identity

Version one binds:

- overlay ID and revision;
- issue and expiry times;
- adapter and execution surface;
- optional provider, model, and profile;
- protocol, harness, and tool-manifest fingerprint;
- task classes, risk classes, and deterministic priority;
- repositories, projects, resources, write classes, and operations;
- exact file and metadata fences;
- checks, stop conditions, review policy, expected revision, and evidence references;
- bounded instructions;
- one canonical SHA-256 overlay fingerprint.

Repositories use canonical lowercase GitHub identity. Project identity uses exact lowercase bytes. Uppercase, mixed-case, padded, or case-folded project aliases fail before overlay fingerprinting or selection.

Canonical-state guidance requires an expected commit or SHA-256 revision and independent review policy.

## Selection context

Selection binds the complete active context:

- adapter, execution surface, provider, model, and profile;
- protocol, harness, and tool-manifest identity;
- task and risk class;
- exact repository, project, and resource dimensions;
- write class and operation;
- current commit or SHA-256 revision;
- requested files and metadata fields;
- caller observation time.

Every declared repository, project, and resource dimension must be supplied and match. An undeclared dimension requires `null`. Every requested file and metadata field must be inside its corresponding fence. Empty fences cover only empty requested-target sets.

A non-null expected revision must equal the current revision exactly.

## Trusted liveness

`selectAssuranceOverlayV1()` requires a separately injected trusted clock. The selector reads that clock exactly once through intrinsic `Date` methods.

Selection proceeds only when:

- the clock returns a valid `Date`;
- its canonical UTC value exactly equals `context.observedAt`;
- the trusted time is at or after overlay issue time;
- the trusted time is before overlay expiry.

A missing, throwing, malformed, backdated, future-mismatched, or otherwise unequal clock returns `null`. Clock exceptions and their prose are discarded. Caller time therefore cannot revive expired guidance or cross an issuance boundary.

The attested observation time remains inside the immutable selection context and selection fingerprint.

## Matching and priority

An overlay matches only when every selector, target, operation, write class, revision, file, metadata, and trusted-time condition succeeds.

Among matching overlays, the unique highest priority wins. Equal highest priorities fail as ambiguous. Duplicate overlay ID/revision pairs fail.

Every result is deeply frozen and carries:

```text
authorizesOperation: false
authorizesCanonicalWrite: false
```

## Input safety

Objects and arrays require exact own enumerable data properties. Symbols, accessors, hidden fields, custom prototypes, sparse arrays, decorations, duplicates, malformed identities, invalid timestamps, invalid revisions, and out-of-fence targets fail before selection.

Trusted-clock failures return `null`; contract and catalogue defects remain typed `RangeError` failures.

## Internal boundary

`assurance-overlay-core.ts` preserves the previously reviewed deterministic compiler, target matching, revision matching, priority selection, immutable outputs, and zero-authority projection.

`assurance-overlay.ts` is the canonical public entrypoint. It admits exact lowercase project bytes before delegating to the core and attests the trusted selection time before any liveness decision. Consumers should import only the canonical entrypoint.

## Recovery

Remove the additive contract files before integration, or revert the eventual squash commit. Any future loader can be disabled independently while compiled overlay and selection receipts remain ordinary immutable evidence.
