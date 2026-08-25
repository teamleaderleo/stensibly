# Agent and execution identity

## Purpose

Use names only where they distinguish facts with different correctness, recovery, or authority semantics.

Stensibly does **not** require a universal work hierarchy such as `Project → wave → lane → action → run`. Terms such as wave, lane, campaign, phase, or stream may remain useful human descriptions, but they are optional labels unless a concrete product contract gives them an invariant that existing records cannot express.

Related:

- #45 — durable coordination without a permanent manager layer
- #46 — deterministic wake conditions
- #214 — end-to-end executable work-cycle proof
- #280 — closed work-scale taxonomy experiment
- `docs/product-model.md` — responsibility and authority remain distinct

## Canonical identities

### Project

The durable product/repository coordination boundary.

A project groups policy, repository attachments, work, and provider scope. Project identity may outlive every current worker and run.

### Work item / responsibility

The durable thing that still needs an outcome.

A work item identifies the user-visible or project-visible outcome. Responsibility identifies the current obligation/generation to produce the next result when that distinction is required by the owning contract.

Do not create another `action` identity when an existing work item, continuation, command, or decision already names the executable unit precisely enough.

### Run

One bounded execution attempt.

Run-scoped facts include, when relevant:

- exact work/responsibility generation;
- worker/actor reference;
- runner profile and exact profile version;
- provider/model/reasoning configuration;
- repository/base/candidate identities;
- lease/authority generation;
- checkpoint/continuation lineage;
- terminal execution state.

A failed or replaced run does not erase the durable work item. A compatible hot resume keeps the exact execution profile required by the runner contract; an execution-affecting profile change creates a successor run.

### Worker / actor

The principal or durable worker reference that performed an action.

Shared transport identities such as one GitHub account may represent several workers. Preserve the exact worker/run identity that the owning action contract uses for attribution.

Worker identity grants no authority by itself.

### Callsign

Human-readable display metadata for distinguishing concurrent/disposable workers.

A callsign is useful for reading comments, receipts, and handoffs. It is never the canonical lookup key for work, identity continuity, competence, responsibility, or permission.

The normal hosted path is the pool-backed `enrol_worker(project, workerSessionId)` default from #1676: omit `callsign`, optionally give a broad category, and use exactly the accepted name/sigil/lease generation. Manual names remain an override/fallback.

### Continuation / handoff

A durable successor reference carrying the smallest state needed for another worker/run to continue current responsibility.

Continuity belongs to durable work and exact source references, not to one conversation or callsign.

### Authority / approval

Permission remains a separate typed fact with its own generation, expiry, target, and effect constraints.

Names, assignment, issue labels, callsigns, model profiles, and human-readable roles never substitute for authority evidence.

## Optional descriptive labels

Humans may use words such as:

- wave;
- lane;
- campaign;
- phase;
- stream;
- reviewer;
- coordinator;
- manager.

Use them as prose when they make a large effort easier to discuss. Do not require them in every header, handoff, run, issue, or schema.

Before promoting one into a durable field, name the exact failure it prevents and prove existing project/work/run/dependency/continuation records cannot express the needed invariant.

## Display guidance

Prefer the shortest display that preserves the facts relevant to the reader.

A normal work update can be:

```text
Issue: #1676
Run: run_...
Worker: <accepted callsign>
Candidate: <exact revision when relevant>
Next: <one executable action>
```

A provider-effect receipt should emphasize the effect identity, authority generation, idempotency identity, and observed settlement instead of a work taxonomy.

A review should emphasize the exact candidate/input set and verdict. Independent review is consequence/uncertainty-based; it is not implied by a named reviewer lane.

## Programmatic rule

If a value can be reconstructed safely from canonical records, derive it in a view instead of asking workers to repeat it.

If a repeated naming or coordination distinction affects correctness, encode the smallest invariant directly:

```text
conflicting responsibility -> atomic claim/generation
future eligibility -> wake condition
fresh worker continuation -> context/continuation compiler
external effect -> command + receipt + reconciliation
human choice -> exact decision input fingerprint
stale review -> exact reviewed input identity
```

Do not create an organizational layer as a proxy for one of these invariants.

## Legacy prose

Historical issues, comments, and documents may refer to waves, lanes, pods, task groups, mantles, supervisors, or other experiments. Treat those terms as historical/descriptive unless a current canonical contract explicitly depends on them.

Do not mechanically rewrite historical evidence merely to match current vocabulary.

## Adoption

Current code and new documentation should default to:

```text
project
work/responsibility
run
worker/actor
continuation when needed
authority/approval when needed
```

Add more identity only after a concrete failure demonstrates a missing distinction.

## Deletion rule

When a naming convention stops carrying a unique invariant or repeatedly duplicates existing state, remove the requirement and keep the historical text in Git.

— Kestrel
  Intention: name only the identities that software must distinguish
