# Stensibly engineering handbook

**Status:** living contributor guide  
**Owner:** #693  
**Last reviewed against `main`:** `9c5fea6520cbc902c7d9221c5172228833e083a8`

## In simple words / purpose

This is the code-level guide for Stensibly. It turns the product model, correctness
rules, and accepted review lessons into implementation habits a contributor can use
while reading or writing code.

Use it beside the [code atlas](code-atlas.md), which points to current-main examples.
The deeper reasons remain in the product, architecture, correctness, operations, and
decision documents linked below.

## How to read this guide

Three kinds of guidance appear here:

- **Required invariant** — behavior needed for authority, privacy, compatibility,
  correctness, recoverability, or the product contract.
- **Repository convention** — the preferred local implementation style. Departures
  need a concrete reason and equivalent proof.
- **Active experiment** — a provisional practice owned by a tracking issue or decision
  record. Experiments may be accepted, revised, or removed.

A recent implementation becomes an example only after it reaches `main` and the lesson
is crisp. Age, size, and complexity confer no special status.

## Direction of travel

Stensibly is becoming a durable responsibility and authority ledger for humans, agents,
scripts, and services.

### Required invariants

- The server-owned ledger remains authoritative; boards, briefs, dashboards, and
  summaries are projections.
- Assignment, identity, authentication, and role labels do not grant current authority.
- Exclusive authority uses leases, generations, or fences that stale holders cannot
  reuse.
- Durable responsibility survives process and conversation loss through explicit
  state, evidence, events, outcomes, blockers, handoffs, and next actions.
- External systems retain ownership of source code, files, CI, deployments, provider
  state, private execution, and model calls. Stensibly stores bounded references and
  coordination facts.
- Hosted Convex behavior is the primary production path. SQLite remains a supported
  compatibility mode, so shared contracts must stay explicit.
- The server performs no model calls.
- Credentials and private provider payloads stay outside public errors, receipts,
  browser bundles, retained artifacts, and logs.
- Consequential external effects require current authority, stable command identity,
  bounded approval when required, and a recovery or reconciliation path.
- Product UI follows the repository no-gradient rule.

Read [the product model](product-model.md), [architecture](architecture.md), and the
[coordination correctness model](coordination-correctness.md) before changing these
boundaries.

## Component ownership

Keep one owner for each decision and state transition.

- **Ledger contracts** own domain behavior shared by SQLite, Convex, REST, MCP, and
  browser clients.
- **Convex** owns hosted durable state and hosted authentication decisions.
- **SQLite** implements local compatibility against shared contracts.
- **Cloudflare Worker** owns the public hosted HTTP boundary, authentication, scope
  enforcement, CORS, and trusted Convex calls.
- **Dashboard and Labs surfaces** consume admitted data. They do not invent parallel
  authority or domain rules.
- **Provider adapters** translate an already-authorized Stensibly operation into a
  bounded external call and validate the returned provider evidence.
- **Tests and verifiers** prove contracts. They carry no runtime authority.

When a browser, adapter, or transport layer starts deciding a shared domain rule, move
that rule to the smallest authoritative ledger or service boundary that owns it.

## Admit untrusted values once

### Required invariant

Any value crossing a public, provider, persistence, plugin, fixture, or exported service
boundary is untrusted until runtime admission succeeds.

### Repository convention

Use a named admission function that:

1. inspects the original runtime value through primitives appropriate to its trust
   boundary;
2. chooses and documents the caller key-set model when decorations or unknown fields
   are relevant;
3. rejects unsupported prototypes and invalid declared fields;
4. snapshots admitted data without invoking accessors, callbacks, iterators, or other
   caller-controlled behavior;
5. applies unknown-field rejection only where the complete key set is safely and
   deliberately observable;
6. validates original bytes where identity is authority-bearing;
7. performs only the intended canonicalization;
8. validates relationships and current status;
9. returns a frozen admitted value.

Re-admit a structurally typed value received through an exported boundary. TypeScript
shape proves compile-time compatibility inside a trusted compilation unit; it does not
prove runtime provenance.

### Caller key-set policy

An arbitrary caller-owned object cannot both avoid caller key enumeration and prove
that no undeclared own fields exist. Pick the boundary model explicitly:

- **Closed after trusted key-set establishment:** unknown fields are invalid, and exact
  keys are checked only after a bounded parser, decoder, or compiler-owned detached
  record makes the complete key set safely observable.
- **Projection-style fixed-descriptor admission:** inspect only declared own enumerable
  data descriptors, ignore unrelated decorations, and keep those decorations out of
  identity, authority, persistence, fingerprints, and output.
- **Bounded enumerated caller admission:** enumerate the caller key set deliberately
  under an explicit source/key/byte bound, contain enumeration failures, and reject
  unknown fields when the contract is closed.

Reading every known descriptor proves the known fields; it does not prove the absence
of unknown fields. Changing a public or versioned input from unknown-field rejection to
decoration discard is a compatibility decision, not an inspection-only refactor.

Missing, accessor-backed, non-enumerable, malformed, or prototype-incompatible declared
fields remain independently rejectable in every model. Arrays make the same separate
choice for non-index decorations after length and direct-index admission.

See [the caller-admission boundary decision](decisions/1247-caller-admission-boundaries.md)
for rationale, examples, and test guidance.

### Why descriptors appear often

Direct property reads, spreads, iteration, `Object.values`, and caller-controlled array
methods may execute getters or inherited code. `Object.keys` ignores symbols and hidden
fields and also invokes caller key enumeration. Direct descriptor reads are useful when
a boundary needs fixed-field projection without executing accessors or `ownKeys`; exact
unknown-field rejection requires a separate complete-key-set decision.

Use simpler validation for genuinely internal values whose creator and lifetime are
already controlled by the same module.

## Identity before canonicalization

### Required invariant

Validate authority-bearing source bytes before trimming, Unicode compatibility
normalization, URL parsing, case folding, or other transformations that can collapse two
inputs into one identity.

### Repository convention

- Reject surrounding whitespace on persisted IDs, project slugs, credential locators,
  fingerprints, commit identities, timestamps, provider account names, and repository
  selectors unless the public contract explicitly permits it.
- Reject non-ASCII compatibility forms for closed ASCII identities.
- Apply provider equivalence only after exact-byte admission. GitHub account and
  repository case are intentionally canonicalized; secret references and Stensibly IDs
  retain exact identity.
- Detect duplicates after canonicalization.
- Keep display labels, canonical IDs, provider-owned identities, credential references,
  and content fingerprints distinct in names and types.
- Bind immutable external reads to immutable provider identities, such as a full commit
  SHA instead of a mutable branch name.

Canonicalization is an equivalence decision. Treat it as authority-sensitive code.

## Authority and time

### Required invariants

- Authenticate the principal, then separately prove current operation authority.
- Validate project, workspace, repository, resource, generation, lease, fence, grant,
  and approval identity at the boundary that performs the effect.
- Revalidate immediately before a consequential external effect when state may have
  changed since preparation.
- Exact expiry is expired unless the contract explicitly defines another boundary.
- A command issued in the future cannot execute.
- Reject invalid trusted clocks before cache lookup, token construction, scheduling,
  provider dispatch, or mutation.
- Logical sequences and generations own ordering. Wall-clock timestamps serve display,
  deadlines, expiry under a named clock, and provider observations.

### Repository convention

Keep authority guards small and explicit. A guard should accept already-admitted input,
check one current authority question, and return the same immutable value or throw a
bounded domain error.

## Idempotency, retries, and ambiguous effects

### Required invariants

- Stable command identity answers whether one intended effect already ran.
- Authority fences answer whether this actor may act now.
- These checks solve different problems and both may be required.
- A timeout or connection loss creates uncertainty. It does not prove the provider
  effect failed.
- Reconcile provider state before retrying a consequential effect with an ambiguous
  outcome.
- Never claim exactly-once network delivery.

### Repository convention

For a retriable write, preserve:

- stable command or idempotency identity;
- canonical request fingerprint;
- current authority generation or fence;
- bounded attempt identity;
- durable result or terminal rejection;
- provider request/effect identity where available;
- a visible ambiguous state and next observation action.

Tests for rejected or ambiguous paths should prove zero extra dispatch, cache admission,
state mutation, or duplicate event creation.

## Persistence and state transitions

### Required invariants

- Append monotonic observations and evidence.
- Serialize non-monotonic decisions at the smallest aggregate that owns the invariant.
- Preserve revocation, cancellation, supersession, and failed attempts as history.
- A tombstone closes an exact current authority record; it does not erase history.
- Reusing a durable identity with incompatible admitted content is a conflict.
- Stale observations cannot replace a newer current record.
- Reads return admitted current projections derived from durable history.

### Repository convention

- Admit before entering a database transaction.
- Revalidate relationships inside the transaction that owns the decision.
- Store canonical JSON only when it provides useful replay or conflict evidence; do not
  treat JSON text as a substitute for indexed authority columns.
- Use deterministic ordering for histories and current projections.
- Keep SQLite and Convex behavior aligned through shared contracts and parity tests.
- Make migrations recoverable and keep destructive changes behind an explicit data
  plan.

## Provider credentials and returned scope

### Required invariants

- Request the narrowest provider permission and repository selection needed by the
  operation.
- Treat a successful HTTP status as transport success only.
- Verify the complete returned permission map, repository selection, repository
  identities, expiry, and provider-owned account identity before caching or use.
- Partition credential caches by every authority dimension that changes the usable
  scope.
- Reject widened, missing, malformed, or different scope and keep it out of cache.
- Keep raw credentials in trusted memory only.

### Repository convention

Read and discard provider error bodies through a bounded path, then publish fixed
operation/status prose. Provider messages may contain secrets, private names, HTML, or
unbounded content.

## Immutability and determinism

### Repository conventions

- Freeze admitted boundary records and nested collections when downstream mutation
  would invalidate validation or hashing.
- Snapshot accepted provider results into plain frozen JSON graphs.
- Reject sparse arrays, accessor entries, custom prototypes, symbol fields, and array
  decoration when index identity carries meaning and the chosen boundary policy makes
  those fields invalid.
- Normalize `-0`, reject non-finite numbers, bound node count, depth, and UTF-8 bytes,
  then serialize deterministically.
- Sort canonical sets with an explicit comparator before fingerprinting or duplicate
  decisions.
- Use stable JSON and explicit fingerprints for equality across process, storage, and
  provider boundaries.

Freeze after admission. Freezing an unvalidated caller object preserves the caller's
surprises.

## Errors, privacy, and logs

### Required invariants

- Public errors reveal the operation class and bounded status, never credentials or
  untrusted provider prose.
- Logs and receipts omit raw tokens, private keys, service secrets, authorization
  headers, issue bodies unless explicitly required, and full private provider payloads.
- Secret-shaped values are rejected from public authority identity fields.
- Browser bundles contain no trusted service credential.

### Repository conventions

- Use typed/domain-specific errors where callers need a stable recovery decision.
- Keep expected contention and safety failures distinguishable.
- Test error strings only when the public wording is itself a contract; otherwise test
  the error type and effect boundary.
- Redact by construction. Avoid logging first and scrubbing later.

## TypeScript and JavaScript house style

These are repository conventions unless a stronger contract applies.

- Prefer small named functions that express the boundary or invariant.
- Keep runtime admission near the public/exported boundary and business decisions near
  their state owner.
- Use exhaustive switches over closed tool or operation sets.
- Prefer readonly/frozen runtime values for admitted contracts even when an external
  interface requires a mutable TypeScript type.
- Use explicit units in names: `expiresAtMs`, `refreshSkewSeconds`, `maximumBytes`.
- Use exact nouns for identity classes: `commandId`, `attemptId`, `runId`,
  `installationId`, `connectionId`, `bindingId`, `attachmentId`.
- Keep compatibility adapters thin. Shared behavior belongs in shared services.
- Avoid broad utility abstractions until two or more real boundaries share the same
  semantics and tests.
- Avoid caller-controlled callbacks, iterators, methods, or accessors during admission.
- Keep no-gradient styling literal in product and Labs CSS.

## Tests

### Required proof by boundary

- **Admission:** accepted canonical case, first rejected edge, declared-field
  accessor/non-enumerable/prototype controls, and the chosen decoration/unknown-field
  policy; for arrays also cover sparse/direct-index behavior and the applicable
  decoration rule.
- **Authority:** current holder, stale holder, exact issue time, exact expiry, later
  expiry, invalid trusted clock, revoked/suspended state, mismatched scope.
- **Retry:** same command/same fingerprint replay, same command/different fingerprint
  conflict, ambiguous provider outcome, zero duplicate effects.
- **Credentials:** exact requested scope, missing scope, widened scope, wrong repository,
  broad selection, expired token, repeated rejection with zero cache reuse.
- **Persistence:** exact replay, identity conflict, stale chronology, current projection,
  revocation, reopen, rollback/recovery.
- **Privacy:** outbound secret use where required and zero secret echo in errors, results,
  logs, or retained fixtures.
- **Parity:** SQLite, Convex, Worker, REST, MCP, hosted browser, and Labs paths where one
  contract spans them.

### Repository conventions

- Name tests after the invariant and consequence.
- Prove zero side effects on denied paths; a thrown error alone is incomplete evidence.
- Repeat rejected calls when cache or retry behavior is part of the risk.
- Test the accepted bound and one beyond it.
- Use synthetic secrets and fictional data.
- Keep focused regression tests near the owning source; use broader journeys for
  composition and hosted verification.
- Treat generated or fixture contract tests as executable documentation.

## Ten recurring pitfalls

| Pitfall | Prevention rule | Current example |
| --- | --- | --- |
| Trimming or NFKC-normalizing an authority identity before validation | Admit exact source bytes first, then apply intentional provider equivalence | [Binding admission](code-atlas.md#1-strict-github-provider-binding-admission) |
| Reading untrusted properties directly | Inspect descriptors and snapshot data properties without invoking accessors | [Binding admission](code-atlas.md#1-strict-github-provider-binding-admission) |
| Treating fixed-descriptor projection or `Object.keys` as complete unknown-field proof | Choose closed-after-trusted-key-set, projection-style, or bounded-enumerated admission explicitly; require a complete key-set boundary when rejecting unknown fields | [Caller-admission decision](decisions/1247-caller-admission-boundaries.md) |
| Trusting a TypeScript shape at runtime | Re-admit values crossing exported, provider, or persistence boundaries | [Delegated read boundary](code-atlas.md#4-guarded-delegated-github-read-boundary) |
| Treating HTTP 2xx as exact provider authority | Verify the complete returned permission and repository scope before use or cache | [Provider guidance](#provider-credentials-and-returned-scope) |
| Returning mutable validated objects | Snapshot and deeply freeze admitted records and result graphs | [Binding admission](code-atlas.md#1-strict-github-provider-binding-admission) |
| Using timestamps as the concurrency protocol | Use sequences, generations, and fences; keep time for deadlines and observations | [SQLite history](code-atlas.md#3-append-only-sqlite-provider-binding-history) |
| Treating idempotency as stale-authority protection | Carry both stable command identity and the current fence/generation | [Runner authority](code-atlas.md#2-invocation-time-runner-authority) |
| Retrying an ambiguous provider write immediately | Observe and reconcile before another consequential attempt | [Coordination correctness](coordination-correctness.md#6-cross-aggregate-and-external-workflows) |
| Keeping review acceptance after the head changes | Re-fetch exact head, complete diff, checks, reviews, threads, and recovery | [Contributing guide](../CONTRIBUTING.md#pull-requests) |

Add a pitfall when the same defect appears in more than one lane, causes a material
repair, or expresses a reusable safety rule. Keep one owner for the active wording.

## Change sizing, review, and recovery

### Required invariants

- Every candidate has an exact head, current base, complete file/effect fence, relevant
  checks, review disposition, and recovery path.
- A material head movement expires prior acceptance unless semantic identity is proved
  inside the reviewed fence.
- Final merge candidates contain intended source and documentation only. Temporary
  workflow carriers, branch-writing helpers, generated diagnostics, and execution
  artifacts stay outside the final head.
- Deploy and verify when delivery requires runtime evidence.

### Repository conventions

- Prefer finishing, repairing, reviewing, integrating, simplifying, or cleaning active
  work before opening a competing implementation.
- Keep one PR responsible for one coherent outcome.
- Add a decision record when rationale or consequences must outlive the PR.
- Prefer fix-forward when the live state remains safe and recoverable.
- Revert a bounded squash commit when rollback is clearer.
- Record the next executable action, not a vague future intention.

Read [AGENTS.md](../AGENTS.md), [CONTRIBUTING.md](../CONTRIBUTING.md), and the
[documentation system](documentation-system.md) for the operating and review protocol.

## User-interface conventions

- Preserve the no-gradient rule across production and Labs surfaces.
- Fixture and research surfaces state their fictional or local authority visibly.
- A projection never implies write authority.
- Focus return, keyboard paths, reduced motion, native scrolling, and responsive
  behavior belong in the implementation contract when the interaction uses them.
- Reuse shared fixture truth instead of rendering a second contradictory model.
- Security headers remain narrow by route; experimental framing or scripts must not
  widen production routes.

## Active experiments

The repository may carry active instruction or product experiments. Their issue and
identity must be visible in the owning document. Experimental guidance never silently
becomes a permanent invariant.

At this edition, `documentation-brief/1` remains owned by #666 and
[the documentation system](documentation-system.md).

## Maintaining this handbook

- #693 owns the active handbook and atlas convention.
- The handbook owns concise current conventions. Deeper documents own rationale and
  full models.
- The atlas points only to code on `main`.
- A merged change that establishes or overturns a recurring convention should update
  these pages or state why no update is useful.
- Remove superseded examples from the active atlas and preserve history through Git,
  issues, PRs, and decision records.
- Review the pages after clusters of repeated findings and during operating-protocol
  revisions.
- Keep the guide shorter than its evidence. Link outward instead of copying full source,
  tests, logs, or provider payloads.

## Deeper references

- [Product model](product-model.md)
- [Architecture](architecture.md)
- [Distributed coordination correctness](coordination-correctness.md)
- [Documentation and durable decisions](documentation-system.md)
- [Hosted operations](operations.md)
- [Convex backend](convex-backend.md)
- [Code atlas](code-atlas.md)
- [Engineering-handbook decision](decisions/693-engineering-handbook.md)
