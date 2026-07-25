# Product model: the board shows the work; the ledger governs who may do it

## Status of this document

This note records Stensibly's product identity and the design consequences that follow from it. It is a product and architecture decision, not a claim that every described enforcement mechanism is already complete.

For the distributed-systems rules behind claims, leases, fencing, retries, events, and external effects, see [coordination-correctness.md](coordination-correctness.md).

## The simplest useful interpretation

At its simplest, Stensibly is a collaborative Kanban-style board:

- work exists as items;
- items move through states;
- people and agents can inspect the same project;
- dependencies, evidence, history, and next actions are visible;
- multiple clients can coordinate through one real-time system of record.

That interpretation is valid. It is also incomplete.

Kanban is the clearest human-facing projection of the ledger. It is not the full product boundary.

> **The board shows the work. The ledger governs who may do it.**

Stensibly is a responsibility and authority ledger for human-agent work, presented through a collaborative project board.

## Why a task board is not enough

A normal task board mainly records descriptive and social facts:

- this card is in progress;
- this person is assigned;
- this dependency appears blocked;
- somebody left a comment;
- the team expects a particular next step.

Human teams make those facts work through memory, convention, conversation, and judgement. A colleague usually understands that an old assignment may no longer be valid, that a stalled task needs attention, or that a production deployment requires approval.

Machine workers cannot safely depend on those informal assumptions. They restart, retry, duplicate requests, lose conversational context, operate concurrently, and may resume with stale state. A machine-readable task status does not answer whether a worker still has permission to act.

Stensibly therefore treats coordination as more than state display. It must answer and, where possible, enforce:

- Who currently has authority to act on this work?
- Which exact authority grant are they using?
- When does that authority expire?
- Which actions are inside that grant?
- Which resources may the actor consume?
- Which dependencies make the work ineligible?
- What responsibility did the actor accept?
- What evidence, result, or handoff must the actor leave?
- What happens when the actor stalls, disappears, retries, or returns late?
- Which decisions may be made autonomously, and which require escalation?

## Authority and responsibility are different

### Authority

Authority is the server-recognised right to perform a bounded action.

An authority grant should be identifiable and rejectable. Depending on the aggregate, it can include:

- workspace, project, item, run, reservation, or workflow identity;
- holder identity;
- allowed operation or capability;
- generation or fencing token;
- lease expiry;
- project and credential scope;
- concurrency or resource limits;
- approval state for consequential actions.

Authority is not established merely because an actor name appears on a card. It is established by a current server-owned grant whose conditions still hold.

### Responsibility

Responsibility is the durable obligation accepted by an actor when it takes work.

A responsibility can include:

- the intended outcome;
- the next action;
- heartbeat or check-in expectations;
- required evidence and artifacts;
- explicit blockers and dependencies;
- a handoff obligation when the actor cannot continue;
- an escalation obligation when a decision exceeds its authority;
- a terminal outcome or clear explanation of failure.

Authority says what an actor may do. Responsibility says what the actor has undertaken to do and what it must leave behind for the next actor.

The two must be related but not conflated. A worker can remain responsible for reporting a failure after its authority to perform external side effects has expired. Conversely, a service may have technical permission to call an API without having responsibility for deciding whether that call is appropriate.

## Kanban projection versus governed execution

| Collaborative board | Governed coordination ledger |
| --- | --- |
| An item is marked in progress. | A specific actor holds a current, expiring authority grant. |
| Assignment is descriptive. | Holder, generation, expiry, scope, and operation are checked by the server. |
| A stale card waits for someone to notice. | Expired authority can be detected and invariant state can be reconciled. |
| Dependencies are informative links. | Dependencies can make work ineligible for dispatch. |
| Resource contention is handled socially. | Reservations and concurrency policies can prevent conflicting use. |
| Comments preserve informal context. | Events, artifacts, runs, and handoffs preserve durable continuation context. |
| Retrying an action is left to the client. | Commands need durable identity, idempotent outcomes, and stale-authority rejection. |
| Automation invokes external APIs directly. | Consequential effects require explicit policy, approval, observation, and compensation. |
| Completion is a card movement. | Completion is a semantic transition with actor, authority, evidence, history, and follow-up consequences. |

The visual board remains valuable because humans need a compact representation of project state. The difference is that the board should reflect governed state rather than become a second source of business rules.

## A concrete example

A weak representation says:

> Alpha is working on item 42.

A governed representation can say:

> Alpha holds generation 7 of a fifteen-minute claim on item 42, under a project-scoped principal. The run must heartbeat before expiry, may use one unit of the benchmark reservation, may produce a draft change, and may not merge or deploy without approval. A stale generation cannot renew, release, complete, or cause an external side effect. If Alpha cannot continue, it must record a blocker or handoff with evidence and a next action.

The exact fields will vary by operation. The important difference is that responsibility and authority are explicit enough for another process to validate.

## Product layers

### 1. Shared work model

The base layer is recognisably project management:

- projects and goals;
- work items and statuses;
- priorities and dependencies;
- summaries and next actions;
- artifacts and event history.

This layer must remain useful to humans even without autonomous execution.

### 2. Responsibility ledger

The responsibility layer preserves continuity across actors and sessions:

- claims and assignments;
- check-ins and heartbeats;
- runs and outcomes;
- handoffs and blockers;
- promises and continuations;
- required evidence and decisions;
- explicit ownership of the next action.

This is what prevents work from depending on one chat transcript or one agent's temporary memory.

### 3. Authority control plane

The authority layer governs execution:

- credential and project scopes;
- leases and fencing generations;
- server-owned dispatch and admission;
- reservation and concurrency enforcement;
- allowed-operation boundaries;
- approval requirements;
- stale-action rejection;
- cancellation and reassignment policy.

This layer must fail closed. A failed authority check must never fall back to a weaker ownership convention.

### 4. Durable execution and effects

The execution layer coordinates unreliable processes and external systems:

- command inbox and outbox;
- idempotent replayable outcomes;
- runner adapters;
- observed external effects;
- saga-style progress and compensation;
- human decision queues;
- fault recovery and reconciliation.

This is the layer that makes continuous supervision real rather than simulated by agents repeatedly reading a board.

### 5. Human control and explanation

The human-facing layer should make the above legible:

- what is happening;
- who or what holds authority;
- what responsibility is outstanding;
- why work is eligible, blocked, or awaiting approval;
- what the system did automatically;
- which facts are observations and which are decisions;
- how to intervene without corrupting coordination state.

The board is one view of this layer. Item detail, project briefs, decision queues, audit history, and portfolio views are others.

## Product principles

### Server-owned truth

The server owns shared coordination state and semantic transitions. Browser, CLI, MCP, and agent clients render or request those transitions; they do not invent parallel rules.

### Explicit grants, not implied permission

Being named, assigned, authenticated, or previously active is not sufficient authority. Consequential actions require a current grant whose holder, generation, expiry, scope, and operation match.

### Responsibility must survive the worker

A useful handoff must survive process exit, conversation loss, model replacement, and human absence. Outcomes, blockers, artifacts, and next actions belong in durable state.

### Invariants may be reconciled automatically; meaning requires policy

The system may safely reconcile facts such as an elapsed lease under a reviewed invariant. It must not casually infer that work is complete, wrong, blocked, cancelled, or reassigned. Semantic intervention requires an explicit policy and usually stronger approval.

### Bounded automation

Every autonomous loop needs explicit scope, limits, credentials, concurrency, retry behaviour, and escalation conditions. "Keep improving everything" is a goal, not an executable authority grant.

### External systems remain authoritative for their objects

Repositories own code and commits. CI owns build results. Deployment providers own deployments. Communication systems own messages. Stensibly records references, intent, commands, observations, approvals, and outcomes without pretending to be a global transaction manager.

### Explainability is part of control

Humans must be able to tell why an actor received work, why an action was rejected, what authority was used, what evidence exists, and what happens next. An opaque autonomous result is not sufficient coordination.

## Litmus tests

### Is this merely a collaborative task board?

It is functionally only a task board when agents:

- poll cards;
- choose work independently;
- rely on assignment labels as permission;
- call external systems directly;
- leave progress in comments;
- depend on humans to notice stale work;
- cannot prove which authority grant produced an action.

No amount of extra card metadata changes that conclusion.

### Is this governed orchestration?

It becomes governed orchestration when the system:

- determines eligibility from durable state and policy;
- atomically grants bounded authority;
- starts or admits a compatible runner;
- checks holder, generation, expiry, scope, and operation at side-effect boundaries;
- records commands, attempts, observations, and outcomes durably;
- recovers from duplicate delivery and stale workers;
- escalates decisions outside policy;
- leaves an understandable audit and handoff trail.

### Fresh-session test

If every worker disappears and later returns in fresh sessions, Stensibly should be able to determine:

- what work still exists;
- which grants remain live;
- which grants have expired or been superseded;
- which commands have already produced effects;
- which responsibilities remain unmet;
- what can be retried safely;
- what must be escalated to a human.

A conventional board cannot answer all of these. This is the standard the product should grow toward.

## Current capability versus intended boundary

Stensibly already has meaningful parts of this model: durable projects and work, server-enforced scopes, claims and expiries, run lifecycle state, dependencies, reservations, append-only events, artifacts, handoffs, idempotency mechanisms, hosted sessions, and early authority fencing.

It does not yet provide unattended end-to-end orchestration. Important remaining work includes complete claim and run fencing, durable command delivery, causal event envelopes, runner adapters, fault-model testing, external-effect workflows and compensation, conservative custodian policy, and a long-lived supervisory loop.

Documentation and interfaces must distinguish these states clearly. The product should not market intended guarantees as completed guarantees.

## Design consequences

### For APIs

- Mutation inputs should carry exact authority evidence where an operation depends on exclusive control.
- Responses should expose enough redacted authority and responsibility state for clients to explain decisions.
- Idempotency and authority fencing must remain separate checks.
- Public projections must be bounded and project-isolated.
- Semantic transitions should have exact validators and durable events.

### For the dashboard

The interface should make authority and responsibility visible without turning item detail into an unstructured metadata dump. Useful questions include:

- Who holds this work now?
- Until when, and under which generation?
- Is the holder healthy and heartbeating?
- Which resources are reserved?
- What is the outstanding responsibility and next action?
- Which actions are permitted, prohibited, or awaiting approval?
- What evidence has been produced?
- What changed automatically, and why?

A future authority panel should derive from server contracts rather than reconstructing authority from unrelated fields.

### For supervisors and custodians

- Selection and intervention policy must be explicit and versioned.
- Observation, recommendation, dry-run, invariant reconciliation, and semantic action are distinct modes.
- Supervisors must not silently widen their own scope.
- Custodians should default to observation and bounded invariant repair.
- Human approval should remain durable state, not a transient chat acknowledgement.

### For project integration

Attaching Stensibly to a repository should establish a small, explicit control contract:

- project identity and boundaries;
- allowed repositories and environments;
- runner profiles and capabilities;
- concurrency and resource limits;
- permitted autonomous actions;
- required approvals;
- escalation routes;
- expected artifacts and handoffs;
- credentials scoped to those decisions.

A repository-local instruction file can describe project-specific policy, but the durable server remains authoritative for live grants and execution state. Static Markdown must not become a bearer token or mutable lock.

## Product language

Preferred concise descriptions:

- **A responsibility and authority ledger for human-agent work.**
- **A coordination control plane for humans, agents, scripts, and services.**
- **The board shows the work. The ledger governs who may do it.**

Avoid reducing the product to "an AI Kanban board". Also avoid claiming a fully autonomous operating system before the execution and authority guarantees exist end to end.

## Non-goals

Stensibly is not intended to:

- replace source control, CI, deployment, storage, or communication providers;
- store private model reasoning or make chat history the system of record;
- make model calls inside the ledger server;
- infer unlimited permission from a broad goal;
- guarantee exactly-once network delivery;
- treat every external action as one global transaction;
- automate semantic project decisions without an explicit policy boundary;
- hide coordination failures behind a polished board.

## Near-term product direction

The next work should prove the distinction above in real use rather than adding generic task-management ornamentation.

Priority order:

1. finish end-to-end authority fencing without weakening actor or payload validation;
2. make authority and outstanding responsibility legible in the item-detail contract and UI;
3. run one real project in guarded, single-runner mode and record friction;
4. add durable command delivery before allowing unattended retried effects;
5. add one production-quality runner adapter and a bounded supervisor loop;
6. keep merges, deployments, messages, provider changes, spending, and other consequential effects behind durable approval until workflow and compensation semantics exist;
7. expand custodian automation only from observation to reviewed invariant reconciliation, not broad semantic control.

Success is not a busier board. Success is a project where workers can disappear, restart, hand off, retry, and be replaced without losing responsibility, duplicating effects, or acting under stale authority.
