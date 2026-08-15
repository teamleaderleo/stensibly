# Decision: Separate caller inspection from unknown-field policy

- **Status:** accepted
- **Date:** 2026-08-15
- **Owning issue:** #1247
- **Implementation:** #1222, #1365, and current repository-observation admission on `main`
- **Supersedes:** none
- **Superseded by:** none

## In simple words / purpose

A hostile caller object can be read through a fixed set of data descriptors without
running getters or `ownKeys`, but that inspection cannot also prove that unrelated own
fields are absent. Stensibly therefore treats **safe inspection** and **unknown-field
policy** as separate contract decisions and names the boundary model explicitly.

This is the reusable admission guideline for work that discusses exact schemas,
decorations, direct descriptors, or zero caller key enumeration.

## Context and evidence

Several caller-boundary repairs reached the same JavaScript constraint independently.
Reading only declared descriptors can prove that required fields exist as own enumerable
data properties. It cannot prove that the object has no additional own string or symbol
keys because that fact requires some form of key-set observation.

The repository already contains two useful accepted patterns:

- #1222 uses projection-style caller admission for the work-stack compiler: declared
  descriptors are snapshotted and unrelated decorations are intentionally discarded;
- #1365 uses fixed declared descriptors for the hostile outer repository-observation
  envelope. Current repository-observation code applies the same technique to the
  hosted input shell, then validates parsed canonical observation JSON through exact
  key-set checks after `JSON.parse()` has produced a detached record.

Those examples show why the words "closed schema" and "zero `ownKeys`" must not be
combined casually at an arbitrary caller-owned object boundary.

## Decision

Every record or array admission boundary chooses one of these models before choosing
its inspection primitive.

### 1. Closed schema after trusted key-set establishment

Use this when unknown fields are semantically invalid and exact vocabulary is part of
the contract.

Establish the complete key set only after the value has crossed a boundary where key
observation is trusted and bounded, such as:

- JSON decoded from already-bounded bytes;
- a compiler-owned detached record;
- a provider/backend value that has first been copied by a separately reviewed bounded
  decoder.

At that point exact-key rejection is meaningful. Direct descriptor reads may still be
used afterward to prevent later accessor or substitution behavior.

### 2. Projection-style fixed-descriptor admission

Use this at a hostile caller boundary when unrelated decorations are intentionally
non-semantic.

- inspect the prototype and only the declared own descriptors;
- require each declared field to be an enumerable data property;
- ignore unrelated own fields without enumerating them;
- exclude ignored fields from fingerprints, authority, persistence, output, and other
  semantic identity;
- document decoration tolerance as accepted input behavior.

Missing, accessor-backed, non-enumerable, malformed, or prototype-incompatible declared
fields still fail admission. Decoration tolerance does not weaken those checks.

### 3. Bounded enumerated caller admission

Use this when the caller key set itself is safe and necessary to inspect.

- impose a reviewed key/count/byte bound appropriate to the runtime and source;
- enumerate the caller key set deliberately;
- reject unknown fields when the contract is closed;
- contain Proxy/enumeration failures behind fixed diagnostics;
- describe the boundary as enumerated admission, not zero-`ownKeys` admission.

### Contract rule

A boundary must not claim exact unknown-field rejection from a fixed descriptor list
alone. Reading every known field proves presence and admissibility of those fields; it
does not prove absence of every unknown field.

Changing an existing public or versioned input from exact unknown-field rejection to
decoration discard is a contract change. It requires an explicit compatibility decision
and, where appropriate, a new version. An inspection refactor does not silently widen
that contract.

Arrays follow the same rule. Dense direct-index admission can prove the admitted length
and indexed elements without invoking iterators, while unrelated array properties still
need an explicit reject/ignore/unobservable policy.

## Test guidance

Admission tests state the chosen model in the invariant they prove.

For every affected boundary, cover the applicable cases:

- required declared fields are accepted only as own enumerable data properties;
- accessors, custom prototypes, revoked inspection, and sparse required indices fail
  with bounded diagnostics;
- decorations are **rejected**, **ignored**, or **unobservable at this boundary** by
  explicit contract;
- projection-style decorations never alter fingerprints, authority, persistence, or
  returned semantic data;
- closed schemas prove exact unknown-field rejection at the trusted/bounded key-set
  boundary that actually observes the complete key set;
- enumerated caller boundaries prove their key/count/byte ceiling and one value beyond
  it.

## Rationale

This distinction preserves two useful properties without pretending one primitive
provides both:

- descriptor projection can prevent caller code from running during fixed-field
  admission;
- exact schemas can still reject unknown fields once a complete key set is safely
  observable.

Keeping the choices separate also makes compatibility review clearer. Reviewers can ask
whether decorations are semantically invalid, intentionally ignored, or already removed
before admission instead of inferring that policy from a helper name.

## Alternatives considered

### Treat direct declared descriptors as exact-schema proof

This was attractive because it gives a compact zero-`ownKeys` implementation. It was
declined because the primitive never observes undeclared keys and therefore cannot
prove their absence.

### Enumerate every arbitrary caller object

This preserves exact unknown-field rejection directly. It was declined as a universal
rule because hostile Proxies can execute caller-controlled enumeration behavior, and
some boundaries have no safe pre-enumeration key ceiling. Bounded enumeration remains a
valid model where the source and limits make it reviewable.

### Ignore decorations everywhere

This produces simple hostile-object admission. It was declined as a universal rule
because public/versioned exact schemas, canonical decoded records, and some authority
contracts rely on unknown-field rejection for compatibility and identity.

## Consequences

### Benefits

- admission reviews can distinguish inspection safety from schema compatibility;
- zero-`ownKeys` repairs stop implying an exactness guarantee they cannot establish;
- public/versioned contracts receive explicit review before decoration tolerance is
  introduced;
- fixed-descriptor projection remains available for hostile caller inputs;
- exact key vocabularies remain available after trusted or explicitly bounded key-set
  establishment.

### Costs and accepted imperfections

- helpers named `closed` may still exist in older source even when their outer caller
  behavior is projection-style; the behavioral contract and tests take precedence over
  the helper name;
- some flows use more than one model in sequence, for example a projection-style outer
  shell followed by exact canonical JSON validation.

### Risks and mitigations

- **Risk:** a future refactor silently changes reject-to-ignore behavior. **Mitigation:**
  tests state decoration policy and versioned inputs require explicit compatibility
  review.
- **Risk:** an "exact" validator is placed before a hostile enumeration boundary.
  **Mitigation:** identify where the complete key set becomes safely observable and
  test that boundary directly.

## Validation

- **Evidence already available:** #1222, #1365, current
  `src/github-repository-observation-admission.ts`, and their hostile-object controls.
- **Acceptance signal:** new admission reviews can cite one of the three models and
  tests make decoration policy explicit.
- **Failure signal:** a zero-`ownKeys` repair claims unknown-field rejection without a
  separate complete-key-set observation, or a versioned exact contract begins ignoring
  decorations without an explicit compatibility decision.
- **Review period:** permanent repository convention until superseded by a stronger
  bounded JavaScript admission model.

## Recovery and supersession

A future runtime primitive or repository-wide decoder may make a different trade-off
possible. Supersede this record with an issue-backed decision that names the new key-set
proof and migration rule. Keep callers on their existing public compatibility behavior
until that replacement is reviewed and adopted.

## History

- 2026-08-07 — proposed in #1247 after the same conflict appeared in #1222,
  #1238, and #1241.
- 2026-08-15 — accepted from current `main` evidence after the work-stack and
  repository-observation caller-boundary repairs settled.
