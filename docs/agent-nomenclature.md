# Agent and work-group nomenclature

## Status

**Provisional convention for dogfooding and iteration.**

This note defines a shared naming and display convention for human-agent work in Stensibly. It is intentionally easier to revise than the durable ledger schema. Real usage should drive later changes.

Related work:

- #230 — temporary agent task groups and bounded integration
- #248 — delegation waves and independent lanes
- #272 — durable pods and operating context
- #278 — pod charter, practice, memory, and lifecycle
- #280 — wave, lane, action, and run as separate work scales
- `docs/product-model.md` — authority and responsibility remain distinct from names and assignments

## Decision

Use a **broad-to-granular work address**:

> **Project → wave → lane → action → run**

Pod membership, temporary stance, callsign, mantle, durable actor identity, and authority are separate metadata. They may be displayed beside a work address, but they are not part of the work hierarchy and must not be used as substitutes for authority evidence.

A complete human-readable heading can be:

> **Stensibly · W01 Production OAuth Enablement · Client Lifecycle · Add expiry cleanup · r03**

A compact machine-oriented path can be:

```text
stensibly/production-oauth/client-lifecycle/add-expiry-cleanup/r03
```

This follows the same principle as a collection, book, chapter, section, and revision: durable context comes first, followed by progressively more specific work.

## Why broad context comes first

The ledger is usually entered through context:

1. Which project contains the work?
2. Which meaningful outcome is being pursued?
3. Which coherent thread contains this work?
4. What directly executable action is next?
5. Which bounded attempt produced the current evidence?

Broad-first ordering keeps related records together in exports, URLs, logs, audit views, and lexicographic sorting:

```text
stensibly/production-oauth/client-lifecycle/add-expiry-cleanup/r01
stensibly/production-oauth/client-lifecycle/add-expiry-cleanup/r02
stensibly/production-oauth/security-acceptance/review-expiry-pr/r01
stensibly/guarded-pilot/supervisor-runtime/start-one-runner/r01
scrapbook/navigation-rework/activity-geometry/verify-transition/r01
```

Granular-first ordering would group records by ephemeral runs, workers, or tool sessions instead of the durable body of work.

## Work scales

### Project

The durable body of work.

```yaml
project:
  slug: stensibly
  title: Stensibly
```

Projects outlive waves, lanes, actions, runs, pods, processes, and conversations.

### Wave

A longer-lived coordinated span pursuing one meaningful outcome. A wave may involve several repositories, pods, lanes, and successive workers.

```yaml
wave:
  sequence: 1
  slug: production-oauth
  title: Production OAuth Enablement
  goal: Enable production OAuth and connect the ChatGPT app
```

Suggested display:

```text
W01 · Production OAuth Enablement
```

A wave should carry a goal, success or stopping conditions, active commitments, current summary, and lineage. It may last across many chats and runs.

A wave is not a temporary worker group. Several groups or pods may contribute to one wave, and one pod may contribute to several waves within approved scope.

### Lane

A medium-lived coherent work thread within a wave. A lane groups related work that benefits from stable context and explicit handoffs.

```yaml
lane:
  key: A
  slug: client-lifecycle
  title: Dynamic-client lifecycle
```

Example lanes within one wave:

```text
A · Dynamic-client lifecycle
B · Independent security acceptance
C · Production configuration and verification
```

Lane letters are compact contextual labels. They do not imply priority, seniority, quality, execution order, worker identity, or permanent membership.

A lane can move between workers and pods without becoming a new lane. The lane is work, not a seat occupied by one worker.

### Action

A small, directly executable next step that one eligible worker can normally claim, complete, or hand off without another decomposition round.

```yaml
action:
  slug: add-expiry-cleanup
  title: Add the dynamic-client expiry cleanup
  issue: 220
```

Examples:

- add the client-expiry index;
- reproduce one registration-limit failure;
- review PR #281 at an exact head;
- run deployed OAuth metadata checks;
- update a rollout checklist with observed results.

An action may correspond to a GitHub issue, issue subtask, Stensibly item, checklist entry, or generated continuation. Not every action needs a separate GitHub issue.

Actions should remain small enough to claim and verify. A lane may contain sequential and parallel actions, and one action may require several runs.

### Run

One bounded execution attempt by one worker against one action or lane checkpoint.

```yaml
run:
  id: run_01J3M8Q2Y6
  waveId: wave_stensibly_production-oauth
  laneId: lane_client-lifecycle
  actionId: action_add-expiry-cleanup
  actorId: actor_openai_codex_7f3a
  attempt: 3
  claimGeneration: 2
  harness: codex
  model: gpt-5.6-thinking
  repository: teamleaderleo/stensibly
  branch: feature/oauth-client-expiry
  status: running
```

Runs produce evidence, events, artifacts, blockers, completion, or a handoff. A run may fail without failing the action, lane, or wave.

Model, harness, branch, worktree, attempt, and execution status belong to the run rather than the lane title, callsign, mantle, or pod.

## Worker and membership metadata

### Callsign

An optional, human-friendly voice or nickname used during a bounded collaboration.

```yaml
workerDisplay:
  callsign: Nightjar
```

Callsigns should be short, pronounceable, visually distinctive, and safe to discard. A callsign is display metadata. It is not an identifier, credential, authority grant, responsibility record, competence claim, or durable permission.

### Mantle

An optional reusable descriptive identity or working style. A mantle may persist across waves, but it remains descriptive and versioned rather than authoritative.

```yaml
mantle:
  name: Lantern
  version: 2
```

### Pod

A durable operating unit that retains a mission, policy, knowledge, responsibilities, practice, and learning across worker sessions, repositories, waves, and temporary task groups.

```yaml
pod:
  slug: foundry
  title: Foundry
  mission: Build and review bounded production-ready systems
```

A pod may have temporary participants, become dormant, fork, merge, or dissolve under an explicit lifecycle. The pod does not disappear merely because one worker or run ends.

Pod membership is orthogonal to the work address. A pod may contribute to several lanes, and a lane may pass between pods. Moving work or joining a pod does not transfer authority implicitly.

### Temporary task group

A bounded execution group formed around one shared deliverable, integration checkpoint, or short-lived coordination need. It has explicit membership, scope, stopping conditions, and a dissolution or handoff point.

```yaml
taskGroup:
  slug: oauth-rollout-check
  deliverable: Verify one guarded OAuth rollout candidate
  stoppingCondition: Record an independent verdict and handoff
```

A temporary task group may operate within one pod, include participants from several pods, or have no pod affiliation. It can contribute to a lane without becoming the lane, and it dissolves or hands off when its bounded purpose ends.

Pods and temporary task groups both remain outside the canonical work address and separate from actor identity, responsibility, claims, and authority.

### Actor

The durable principal that performs work. An actor may be a human, agent, or service.

```yaml
actor:
  id: actor_openai_codex_7f3a
  name: Codex Worker 7f3a
  kind: agent
  capabilities:
    - repository-edit
    - browser-test
    - pull-request-review
```

Actor IDs should remain stable and machine-oriented. Actor names should remain readable. Neither should encode a temporary lane, callsign, mantle, pod, model, branch, or current authority grant.

Being named, assigned, or affiliated does not itself establish authority.

## What letters and numbers mean

Use letters as compact labels for **parallel work threads within a wave**:

```text
A · Dynamic-client lifecycle
B · Independent security acceptance
C · Production rollout and verification
```

Use numbers only where sequence is real:

- wave `W01`;
- attempt `r03`;
- claim generation `7`;
- event sequence `12`;
- schema or mantle version `v2`.

Do not use `Agent 1`, `Agent 2`, and similar labels as primary identities unless those numbers represent a genuine ordered series. Prefer the lane title, executable action, run ID, and exact revision.

## Canonical and contextual display forms

The ledger should store distinct fields rather than requiring every interface to repeat one long string.

### Full canonical heading

```text
Stensibly · W01 Production OAuth Enablement · A Client Lifecycle · Add expiry cleanup · r03
```

### Work and worker sign-off

```text
Work: Stensibly / W01 Production OAuth Enablement / Client Lifecycle / Add expiry cleanup / r03
Worker: Nightjar · Lantern mantle v2 · Foundry pod
```

### Breadcrumb

```text
Stensibly › Production OAuth Enablement › Client Lifecycle › Add expiry cleanup › Run 03
```

### Lane card within an already visible wave

```text
A · Dynamic-client lifecycle
Current action: Add expiry cleanup
```

### Dispatch queue entry

```text
Add expiry cleanup
Production OAuth Enablement · Client Lifecycle
```

### Search result

```text
Add expiry cleanup
Stensibly · Production OAuth Enablement · Client Lifecycle
```

### Activity event

```text
Nightjar completed exact-head review of Add expiry cleanup.
```

Broad-to-granular is the canonical work identity order. A contextual interface may lead with the most useful local fact when its ancestors are already visible.

## Review convention

Every implementation lane should perform:

1. its own scope and correctness review;
2. one named independent review where practical;
3. wave-level reconciliation before integration.

A review should reference exact work and revision records rather than inventing a separate reviewer-agent identity:

```yaml
review:
  reviewerLane: security-acceptance
  subjectLane: client-lifecycle
  subjectAction: add-expiry-cleanup
  subjectRun: run_01J3M8Q2Y6
  subjectRevision: fc595c8
  verdict: accepted_with_notes
```

Reviewer lane and worker identity remain separate. A replacement worker can continue the same review lane without changing the subject work address.

## Compact update and handoff header

Use this form for progress reports, reviews, and handoffs:

```text
W01/A · Dynamic-client lifecycle
Action: Add expiry cleanup
Run: r03 · Claim generation: 2
Revision: fc595c8
Status: ready-for-independent-review
Worker: Nightjar · Lantern mantle v2 · Foundry pod
Reviewer lane: W01/B · Independent security acceptance
```

Then record:

- completed scope;
- changed files or artifacts;
- commands, checks, and results;
- confidence and remaining uncertainty;
- disagreements and blockers;
- next lane or action owner;
- next action.

## Publishing analogy

| Publishing concept | Stensibly concept |
| --- | --- |
| Series or collection | Workspace or project |
| Book | Wave |
| Chapter | Lane |
| Section or assignment | Action |
| Revision or production pass | Run |
| Author byline | Actor, callsign, or mantle metadata |
| Publishing house or standing editorial organisation | Pod |
| Temporary production crew | Temporary task group |
| Manuscript and citations | Artifacts and evidence |
| Editorial review | Independent review record |
| Publication | Accepted shared deliverable |

The analogy is a display and organisation aid. It does not replace Stensibly's authority, responsibility, claim, run, event, artifact, and approval contracts.

## Canonical rule

> **Order durable work context from broad to granular. Keep work hierarchy separate from worker affiliation. Put ephemeral execution metadata last.**

Field by field:

> **Projects identify durable bodies of work. Waves identify outcomes. Lanes identify coherent threads. Actions identify claimable next steps. Run IDs identify executions. Callsigns and mantles identify voices. Pods identify durable affiliations. Temporary task groups identify bounded collaboration. Actor IDs identify principals. Authority grants identify permission.**

These facts must not be collapsed into one agent name.

## Adoption and revision

Use this convention first in dogfood projects and temporary task groups. Do not migrate the schema merely to encode a display preference.

Observe whether:

- `action` is clearer than `task` or `work item`;
- waves need explicit versions or phases;
- lanes are stable enough to deserve durable identifiers;
- users confuse lanes with worker seats;
- GitHub issues map cleanly to waves, lanes, or actions;
- fresh workers receive enough hierarchy without excessive paperwork;
- a useful smaller unit below run emerges from repeated coordination friction.

Revise the convention when actual use shows that a field is consistently omitted, confused, or poorly sorted. Any later schema proposal should cite observed examples and preserve compatibility with existing actor, item, run, event, artifact, authority, and approval records.
