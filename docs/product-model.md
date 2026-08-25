# Product model: the board shows the work; the ledger governs action

## Purpose

Stensibly is a responsibility and authority ledger for human-agent work, presented through collaborative project views.

The board is the clearest human projection of current work. The durable product boundary is the set of exact records and transitions that decide:

- what work still exists;
- which responsibility generation is current;
- which actor/run may perform which bounded action;
- which condition makes dormant work eligible again;
- which decision needs human judgement;
- which external effect was requested, attempted, observed, or remains ambiguous;
- what a fresh worker needs to continue after every earlier chat disappears.

For distributed-systems details behind claims, leases, generations, idempotency, retries, events, and external effects, see [coordination-correctness.md](coordination-correctness.md).

## The board is a projection

At the human-facing level Stensibly still looks like project management:

- projects and work items;
- statuses, priorities, dependencies, summaries, and next actions;
- artifacts and event history;
- current responsibility and blockers;
- decisions and evidence.

Those views remain useful to humans even when no autonomous execution is active.

The board derives from canonical records. It does not become a second place that business rules, authority, provider state, or queue truth must be maintained.

> **The board shows the work. The ledger governs action.**

## Responsibility and authority are different

### Responsibility

Responsibility is the durable obligation attached to the current work generation.

Depending on the work contract, it can include:

- intended outcome and current next action;
- exact claim/responsibility generation;
- blockers and dependencies;
- required evidence/artifacts;
- a terminal result, decision request, or bounded handoff/continuation.

Responsibility survives the current worker. A fresh worker can read current work and accept a new current generation without inheriting the earlier chat or callsign.

### Authority

Authority is the current server/provider-recognised right to perform one bounded action.

An authority record may bind:

- project/work/run/provider object;
- holder/principal;
- allowed operation/capability;
- generation/fencing token;
- expiry/lease;
- credential/resource scope;
- approval or budget prerequisites.

Names, issue assignment, callsigns, model identity, branches, and prior activity never substitute for current authority evidence.

A worker may remain responsible for explaining a failure after its effect authority expires. A service may possess a credential while having zero responsibility to decide whether an effect should occur. Keeping those facts separate is central to the product.

## Canonical owner model

Use the smallest record that owns each decision.

### Work and responsibility

Work items, dependencies, blockers, current claims/generations, completion, and handoff own the user-visible obligation.

Atomic claim/responsibility transitions prevent two workers from treating the same exclusive generation as current merely because both saw a ready card.

### Runs and execution

A run is one bounded execution attempt. It owns execution identity and the exact liveness/profile/checkpoint facts consumed by runner logic.

Automated executors may expose reliable lease/heartbeat evidence. Interactive chats do not acquire a generic heartbeat requirement merely by participating.

Execution-affecting profile/version changes create a successor run when the runner compatibility contract requires it.

### Future eligibility

Dormant work becomes eligible through explicit conditions/events rather than worker polling:

- absolute time;
- dependency/work transition;
- human decision resolution;
- admitted provider/repository observation;
- explicit manual resume.

A satisfied wake makes work eligible. It grants zero responsibility or effect authority by itself.

### Human decisions

A genuine human decision is an exact typed request bound to the current input/generation and explicit consequences.

Ordinary healthy work does not need a human-attention record. The human-facing exception view should concentrate on unresolved judgement, approval, ambiguous effects, and recovery.

### External/provider effects

External systems remain authoritative for their objects. Stensibly owns the bounded command/authority/receipt/reconciliation record around the effect.

A consequential effect follows this family of states:

```text
exact current inputs + authority
-> reserve/record command identity
-> dispatch provider effect at most as allowed
-> observe provider result
-> read back/reconcile when the contract requires it
-> settle or remain explicitly ambiguous
```

Exact replay returns the stored result where possible. Altered reuse conflicts. Ambiguous outcomes reconcile before another effect attempt.

Some providers require an explicit follow-up trigger after a repository/resource mutation. That trigger is a distinct provider effect and should bind to the exact resulting revision while mechanically preventing recursion. The Bun-lock exact-SHA CI dispatch is one concrete example.

### Context and continuation

A fresh worker should request only the context needed for the current continuation/review/decision/recovery action.

Purpose-bound context can be compiled from canonical work/run/decision/provider records with exact source identities and a fingerprint. Current mutable provider facts are refetched before consequential action.

A handoff preserves facts another worker cannot cheaply reconstruct: non-obvious decisions, exact irreversible/ambiguous effect identity, current candidate/artifact when it is the work product, unresolved blocker/uncertainty, and one next action/clearing condition.

## Board language versus governed coordination

| Collaborative view | Governed coordination |
| --- | --- |
| Item is active. | Exact responsibility/claim generation identifies current ownership when exclusivity is required. |
| Actor/callsign is shown. | Durable worker/run identity provides attribution; callsign remains display metadata. |
| Dependency is visible. | Dependency state may make the exact target ineligible or satisfy a wake condition. |
| Runner appears active. | Current run generation/lease/adapter evidence determines executable liveness. |
| Human input is needed. | Typed decision record binds exact current inputs and consequences. |
| Automation writes externally. | Exact command + current authority + idempotency + provider receipt/reconciliation own the effect. |
| Work is done. | Terminal work/run/effect states and required evidence agree under their owning contracts. |
| Another worker continues. | Fresh worker reads durable continuation/current state and obtains new current generations/authority. |

## Event-driven coordination

Ongoing coordination should react to exact sources instead of maintaining a permanent manager process that scans every worker/project.

A representative path is:

```text
provider/work/time/decision event
-> condition/materiality owner admits it
-> exact target generation becomes eligible
-> dispatcher revalidates target, claim/run state, capacity/profile/authority
-> atomically create/replay one current run
-> runner/provider performs bounded execution/effect
-> ordinary durable observations/outcomes update current state
-> next wake, recovery, decision, or completion follows from canonical records
```

Broad surveys remain useful as explicit diagnostics/overview snapshots. Their fingerprint can help compare two observations. A survey does not become the scheduler merely because it can say that something changed.

Idle is a healthy state when no eligible valuable work exists.

## Human control

The human-facing product should make consequential exceptions legible:

- exact unresolved decision/approval;
- ambiguous external effect;
- stalled/expired run requiring recovery;
- authority/capability mismatch;
- provider/account/configuration prerequisite;
- explicit destructive/external/spend consequence outside standing policy.

Healthy routine execution can stay quiet.

The useful human questions are:

- What exact choice or recovery action is required?
- Which current inputs/evidence make it necessary?
- What consequence follows each option?
- Which effect already happened or remains uncertain?
- What clears the exception?

A permanent worker roster, portfolio queue, throughput leaderboard, or transcript feed is unnecessary for this control function.

## Product principles

### One owner per mutable fact

Current GitHub state comes from GitHub. Current deployment/resource state comes from the provider. Current work/authority/decision/continuation comes from Stensibly. Repository policy history comes from exact Git revisions/files.

Generated views may combine those facts; they should carry source identity and remain rebuildable.

### Explicit grants

Consequential actions require current exact authority/capability/approval/budget state where the owning effect demands it. Prior success or identity does not renew authority implicitly.

### Responsibility survives worker loss

Work outcome, evidence, blocker, decision, and continuation live outside the current conversation. Worker replacement does not require persona inheritance or chat transcript recovery.

### Reconcile objective invariants; keep semantic judgement explicit

Software can deterministically reject stale generations, duplicate commands, mismatched profile versions, expired leases, invalid provider receipts, or broken exact refs.

Product/taste/priority choices and genuinely ambiguous semantic consequences remain explicit decisions when automation cannot decide them from a closed contract.

### Use events before polling

Provider/work/decision events should target affected work directly. Scheduled evaluation remains appropriate for explicit time conditions and sources without a reliable event mechanism.

Avoid generic “check whether every worker progressed” loops.

### Bounded effects

A runner/provider adapter receives only the authority and inputs its exact effect needs. Browser/message adapters, repository writers, deployment controllers, and model runners remain replaceable effect boundaries rather than alternate project managers.

### Explainability follows receipts

A human should be able to recover why an action was admitted/rejected, which generation/authority/command identity it used, what provider observation settled it, and what happens next from durable records.

## Fresh-session test

Imagine every current worker/chat/process disappears.

From durable records and live provider reads, Stensibly should be able to determine:

- which work remains;
- current responsibility/claim generations;
- live/expired/superseded authority;
- current run/profile/checkpoint state;
- which commands/effects already settled or remain ambiguous;
- which conditions/decisions make work eligible again;
- what can be retried safely;
- which exact judgement/recovery requires a human;
- the minimum context a fresh worker needs to continue.

This is the practical distinction between a collaborative board and a coordination ledger.

## Current implementation direction

Meaningful parts of this model already exist: hosted/local durable work, claims/generations, dependencies, run lifecycles, worker enrolment/callsign attribution, project policy snapshots, runner adapters, command/receipt/reconciliation patterns, continuations/handoffs, exact provider operations, and read-only monitor/diagnostic surfaces.

Current focused gaps live with owner issues rather than one supervisory roadmap, including:

- #47 — exact eligibility/wake intent -> generation-fenced run dispatch;
- #1681 / #305 — hosted exact runner-profile-version provenance parity;
- #574 — closing versus settled terminal state and late-effect fencing;
- #676 — read-first checkpoint/resume eligibility;
- #311 — purpose-bound context packets;
- #472 — optional outbound ChatGPT delivery adapter, if browser delivery remains needed;
- provider-specific command/recovery issues for consequential external effects.

The product should describe those boundaries truthfully while they finish. Intended guarantees should become public claims only after their exact owner has executable proof.

## API consequences

- Mutation inputs carry exact generation/authority/idempotency evidence where needed.
- Replay identity and authority checks remain separate.
- Public projections are bounded and project-isolated.
- Historical evidence remains immutable/readable; current mutable provider state is refreshed when it affects action.
- A version/fingerprint belongs in durable state only when a named machine consumer branches on it.
- Repeated machine-decidable rules migrate from prose into validators, typed state, generated projections, or safer APIs.

## Dashboard consequences

The board/item/detail/exception views should derive from canonical contracts and answer current user questions without copying another status ledger.

Useful views include:

- current work/responsibility/blocker;
- run/authority state where it affects action;
- exact human decision/recovery exception;
- provider effect/receipt/reconciliation state;
- relevant evidence/artifacts;
- generated bounded project overview when requested.

Decorative worker/callsign presentation is welcome; it grants no authority or continuity.

## Repository/project integration

Attaching a project to a repository establishes an explicit control boundary such as:

- repository/environment identity;
- accepted project policy/instruction snapshot;
- runner profiles/capabilities;
- allowed/approval-gated effect classes;
- required checks/evidence;
- scoped provider credentials/installation/account binding.

Live grants/runs/provider objects remain with their canonical runtime owners. Static Markdown describes policy; it is never a bearer token or mutable lock.

## Product language

Useful concise descriptions:

- **A responsibility and authority ledger for human-agent work.**
- **A coordination control plane for humans, agents, scripts, and services.**
- **The board shows the work. The ledger governs action.**

Avoid presenting the product as either a generic AI task board or an all-knowing autonomous manager. The differentiator is exact durable coordination across unreliable workers and external systems.

## Non-goals

Stensibly does not aim to:

- replace source control, CI, deployment, storage, or communication providers;
- store private model reasoning or make chat history the system of record;
- make model calls inside the ledger server;
- infer broad permission from a broad goal;
- guarantee exactly-once network delivery where the provider cannot provide it;
- turn every external system into one global transaction;
- maintain a permanent portfolio/worker hierarchy merely for coordination;
- require periodic worker check-ins when exact run/event/condition evidence can own the decision;
- automate semantic judgement without a closed policy/decision boundary;
- hide ambiguous/failed effects behind a polished dashboard.

## Direction of travel

Prioritize direct invariants and end-to-end proof:

1. finish exact event/eligibility -> atomic dispatch without broad scans;
2. finish run/profile/checkpoint/settlement recovery semantics;
3. keep provider effects exact, replay-safe, observable, and recoverable;
4. compile bounded current context/exception views from canonical owners;
5. delete synthetic estimates, copied status, and process instructions when no current machine consumer needs them;
6. prove one production-shaped work cycle can survive worker disappearance/reconnect without duplicate effects or stale authority (#214).

Success is a project where workers can disappear, restart, hand off, retry, and be replaced while responsibility, authority, decisions, effects, and recovery remain exact.

— Kestrel
  Intention: make coordination emerge from exact owners, events, and receipts
