# Autonomous portfolio execution and dormant-work recovery

**Status:** proposed operating-protocol amendment  
**Proposal:** #330  
**Target protocol:** `stensibly-agent-ops/0.2.0`  
**Target wave revision:** `W01 rev 2`  
**Source:** direct human-operator instruction on 2026-07-27

## Purpose

Stensibly workers should not require task-by-task operator prompting to remain useful.
A capable worker should own a meaningful outcome, keep a small portfolio of
non-conflicting work, select the next eligible action at natural boundaries, and
leave enough durable state for another worker to continue when attention becomes
quiet or dormant.

This amendment changes the default from **one action followed by another request
for direction** to **continuous, bounded portfolio execution**.

It does not grant new production, credential, deployment, destructive, spending,
publication, or permission-widening authority.

## Core rule

> Maintain a small explicit portfolio, keep advancing the highest-value eligible
> work, and make every lane independently recoverable.

A worker may hold several related ideas or lanes at once when they do not create
hidden overlap or weaken review independence. One lane should normally be the
primary outcome. Additional lanes may include:

- an independent review or exact-head acceptance;
- repair or integration of an existing candidate;
- rollout preparation;
- reproduction or verification;
- evidence reconciliation;
- documentation or instruction maintenance;
- a separately fenced exploratory candidate.

The portfolio exists to reduce idle time and human micromanagement, not to maximise
the number of open branches or claims.

## Portfolio shape

A useful default is one primary lane plus up to three secondary lanes. This is a
working bound rather than a schema limit. Use fewer when the primary work is broad
or high risk.

For each lane record, when useful:

- outcome and current priority;
- exact issue, PR, branch, revision, or evidence target;
- implementation owner and integration owner;
- expected files or subsystem;
- overlap checked;
- selected risk tier;
- next executable action;
- block, wake, stop, or handoff condition;
- whether another worker may recover, review, repair, partition, or compete.

A worker may move between its lanes without asking the operator for another task.
When one lane blocks on review, CI, a dependency, or another owner, advance a
non-conflicting lane.

## Larger outcome-owned scopes

Workers are encouraged to take scopes larger than one tiny patch when the larger
scope produces a coherent result and remains inspectable.

Before taking a larger scope, state:

1. the outcome being owned;
2. the decomposition into lanes or actions;
3. shared contracts and integration boundaries;
4. overlapping work and existing owners;
5. exact evidence or artifacts expected;
6. review and merge tier for each consequential boundary;
7. stopping, rollback, and recovery conditions.

A larger scope must still allow another worker to continue from durable evidence.
Do not hide several unrelated changes inside one branch merely to appear ambitious.

## Autonomous continuation

At a natural boundary—completion, block, review verdict, CI result, handoff, or
integration decision—a worker should choose the next highest-value eligible action
without waiting for central assignment.

Use the repository work-selection order, then continue from the current wave or
another explicitly ready action. A human ping is not required merely because the
previous action ended.

The worker may:

- continue its primary outcome;
- switch to another portfolio lane;
- review a candidate it did not author;
- repair or integrate a declared stale or blocked candidate;
- prepare rollout or verification evidence;
- update a stale roadmap or instruction record;
- declare a bounded competing candidate when uncertainty justifies it;
- return a documented no-op when the useful work is already complete.

Routine progress updates should focus on results, findings, decisions, changed
risk or authority, blockers, and the next executable work. Repeated lists of
unrelated actions not taken add little value unless an authority or safety boundary
materially affects the next step.

## Overlap and anti-hoarding rules

Autonomous portfolios do not weaken the one-owner rule for overlapping
implementation.

- Keep one implementation owner per overlapping subsystem or shared deliverable.
- Declare stacked, partitioned, repair, or competing work explicitly.
- Do not open a second branch merely because the current owner is temporarily quiet.
- Check current commits, PRs, comments, reviews, and canonical state before editing.
- Do not use portfolio ownership as proof of authority, exclusivity, priority, or
  guaranteed future attention.
- Do not keep more work exclusively assigned than the worker can make legible and
  recoverable.
- A worker cannot be the sole independent acceptance signal for its own Tier 1 or
  Tier 2 final revision.

## Quiet and dormant work

Quiet or dormant attention does not erase durable responsibility, identity,
provenance, branches, findings, or committed effects.

After the applicable freshness threshold, exclusive active execution should no
longer be presumed. Unfinished work may become:

- recoverable;
- shareable;
- repairable;
- transferable;
- partitionable;
- eligible for a bounded competing candidate;
- eligible for another integration owner.

Another worker may declare a bounded continuation when it first reconciles current
state and records:

- the prior holder and exact last evidence;
- whether the work is blocked, stale, dormant, superseded, or still current;
- the continuation, repair, transfer, partition, or competition relationship;
- overlap and file fences;
- which responsibility or authority is newly accepted;
- what remains with the prior holder;
- the exact clearing or integration condition.

The continuing worker must not impersonate the prior worker. The returning worker
may resume anything still current after reconciling transfers, completed work,
competing candidates, and expired authority.

Claims, leases, approvals, credentials, capabilities, and production authority
expire independently and must be reacquired when required.

## Recovery without operator micromanagement

When a worker appears stale or dormant, another eligible worker should not wait for
a human to manually reassign every small action.

A recovery worker may:

1. inspect canonical state and exact artifacts;
2. publish a bounded recovery or continuation declaration;
3. preserve prior provenance and responsibility history;
4. take a safe non-overlapping continuation, repair, review, or competing candidate;
5. expose the work for integration;
6. stop if current policy requires human approval or a named owner remains actively
   executing an overlapping implementation.

Silence is not approval and does not automatically transfer authority. Recovery is
an explicit new attributable action.

## OAuth and W01 direction

W01 exists to enable OAuth and complete the real ChatGPT connection journey.
OAuth being disabled is a temporary gate state, not the intended product outcome.

Workers should continue advancing, in parallel where safe:

- dynamic-client lifecycle repair and exact-head acceptance;
- hosted OAuth verifier selection and repair;
- production configuration preparation without exposing credentials;
- deployment-order and rollback evidence;
- live metadata and challenge verification;
- ChatGPT app creation or refresh;
- tool scan, bounded read, approved low-risk write, and reconnect evidence.

Once the Tier 2 code and verifier gates are satisfied, the next step is the
human-approved Tier 3 production enablement—not another indefinite documentation
loop.

## Authority boundary

This amendment changes work-selection and recovery defaults. It does not itself
authorise:

- production deployment or OAuth enablement;
- creating, copying, exposing, or rotating credentials;
- widening permissions or allowed subjects;
- destructive data operations;
- spending money;
- external publication;
- irreversible migration;
- overriding a concrete security, privacy, authorization, state-machine, data-loss,
  or compatibility blocker.

Tier 3 effects retain the current contemporaneous human-approval policy unless a
narrower standing grant is adopted separately.

## Handoff and portfolio record

A substantive handoff should make the whole portfolio continuable, not only the
last action.

A compact record may be:

```text
— <Callsign> · <pod context, if useful>
  Primary: <outcome / exact target>
  Secondary: <review, repair, rollout, or evidence lanes>
  Current revision: <exact SHA, when applicable>
  Next: <highest-value executable action>
  Recoverable after: <block, dormancy, review, or wake condition>
```

Use more detail only where it improves inspection, review, recovery, or authority
clarity.

## Evaluation

During the W01 trial, observe:

- how often workers continue without another operator prompt;
- useful work completed per active chat;
- collisions or duplicate branches;
- number of lanes left unrecoverable;
- time between a block and useful work on another lane;
- dormant work recovered without provenance loss;
- integration burden caused by larger scopes;
- whether workers still over-narrate routine non-actions;
- whether OAuth reaches the live ChatGPT journey sooner.

## Rollback

Roll back to `stensibly-agent-ops/0.1.1` if the trial materially increases hidden
overlap, abandoned portfolios, integration collisions, unrecoverable work, or
unsafe authority assumptions.

A rollback should preserve the observations, candidates, and handoffs produced
under this amendment.