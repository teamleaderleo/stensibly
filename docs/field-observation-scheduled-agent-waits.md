# Field observation: scheduled waits are not coordination transitions

Date: 2026-07-26  
Status: operator-reported coordination incident and product-design input  
Lifecycle interpretation: corrected against [issue #312](https://github.com/teamleaderleo/stensibly/issues/312)

For the broader product boundary, see [product-model.md](product-model.md). For claims, fencing, retries, and external effects, see [coordination-correctness.md](coordination-correctness.md).

## Source and certainty

This note records an incident reported by the operator during a multi-agent implementation wave. It is not an audit of the external reminder or condition-watch system, and it does not claim that every apparent worker state was technically observable from that system.

The durable evidence is the coordination failure visible to the operator: several delegated lanes stopped producing repository-visible continuation, while scheduled or conditional checks made it unclear whether responsibility, attention, delivery, and readiness had changed.

## Incident summary

Several implementation lanes depended on earlier pull requests merging or reaching reviewed heads. The handoffs named those dependencies and asked workers to hold or resume after the relevant event.

According to the operator, multiple workers created scheduled reminders or condition watches and then remained silent. They did not publish a timely continuation, block, release, handoff, failure, or reconciliation result. The operator could not determine:

- whether a dependency predicate had become true;
- whether a notification had been attempted or delivered;
- whether the worker had observed it;
- whether the worker was quiet, dormant, blocked, ended, or unavailable;
- whether durable responsibility still belonged to that worker;
- whether a claim, lease, or authority grant remained current;
- whether another worker could safely continue;
- what bounded recovery action should happen next.

Human intervention was required to inspect the repository state and restart coordination.

## What the incident demonstrates

### A future check is not a responsibility transition

A reminder or condition watch means that an external system may perform another check or emit another notification. It does not by itself prove:

- delivery to a worker;
- acknowledgement;
- renewed attention;
- resumed execution;
- claim or lease renewal;
- retained or transferred responsibility;
- current authority for a consequential action;
- completion of the blocked dependency.

The external automation may be useful evidence, but it is not the collaboration ledger.

### Silence is ambiguous

The same lack of visible output can mean:

- active work with no recent publication;
- a quiet interactive worker;
- a dormant chat that may later reconcile and resume;
- a named dependency that remains blocked;
- a cleared dependency that nobody has observed;
- a failed or cancelled notification;
- an expired claim or authority grant;
- an ended worker run;
- abandoned or superseded work.

Treating all of these as either active ownership or automatic expiry loses important state.

### Dependency readiness is separate from worker attention

A pull request merging, a workflow succeeding, or another ledger item becoming ready is an external fact. Recording that fact does not prove that a particular worker saw it or resumed work.

A dependency-clear event should make the affected work eligible for reconciliation and continuation. It should not silently reactivate a stale execution context or grant authority.

## Corrected lifecycle model

The original incident analysis leaned too heavily on automatic claim expiry and reassignment. Later dogfood established a more precise model.

### Durable responsibility may outlive active attention

A worker or chat can become quiet or dormant without erasing accepted responsibility. Dormancy means that current attention must not be presumed and exclusive active execution should not be inferred.

Unfinished work may become recoverable, shareable, repairable, partitionable, or deliberately competed while the prior responsibility record remains part of the ledger.

Responsibility changes through an explicit event or policy such as completion, release, transfer, accepted handoff, supersession, cancellation, or a defined responsibility-expiry rule. Silence alone is not that event.

### Claims, leases, and authority expire independently

A short-lived claim, execution lease, approval, credential, or capability may expire while durable responsibility remains recorded. A scheduled check is not proof of renewal for any of them.

Before consequential work resumes, the worker must establish that the required claim, lease, approval, and authority are current.

### The same worker may reconcile and resume

A returning interactive worker may keep its callsign and resume the same durable work after loading current state, checking transfers or supersession, and reacquiring any expired execution authority.

A fresh execution epoch is required when the earlier run truly ended or expired, its authority is no longer valid, the work was transferred or superseded, or current state is incompatible with the old execution context. Time passing by itself does not prove those conditions.

### Notifications describe delivery attempts, not collaboration truth

Stensibly may reference a reminder, webhook subscription, polling job, or condition watcher. That record can explain what notification mechanism was configured and what it reported.

It must not be treated as proof of responsibility, acknowledgement, current attention, resumed execution, or authority.

## State dimensions Stensibly should keep separate

| Dimension | Example states or evidence |
| --- | --- |
| dependency | blocked, predicate satisfied, evidence unavailable |
| notification | configured, attempted, delivered, failed, cancelled, unknown |
| attention | active, quiet, dormant, paused, ended, unknown |
| durable responsibility | offered, acknowledged, accepted, released, transferred, completed, superseded |
| execution claim or lease | current, expiring, expired, fenced, replaced |
| authority | absent, granted, bounded, expired, revoked, approval required |
| work readiness | blocked, recoverable, shareable, ready, review-ready, integration-ready |
| execution epoch | current run, reconciled continuation, replacement generation |

One row must not be used as proof of another.

## Product requirements suggested by the incident

1. Record first-class block events with typed dependency predicates and exact evidence references.
2. Emit durable dependency-clear events without implying worker acknowledgement or automatic resumption.
3. Track notification attempts and delivery separately from collaboration transitions.
4. Project active, quiet, dormant, paused, ended, and unknown attention states without silently rewriting responsibility.
5. Keep durable responsibility distinct from claims, leases, approvals, credentials, and capabilities.
6. Make claim age, generation, renewal, expiry, and fencing visible.
7. Make unfinished dormant work discoverable as recoverable, shareable, repairable, partitionable, or deliberately competing.
8. Support explicit release, transfer, accepted handoff, succession, supersession, and completion events.
9. Require a returning worker to reconcile exact current state before continuing.
10. Support bounded escalation when a dependency clears but no acknowledgement or continuation appears.
11. Preserve exact external references to repositories, pull requests, commits, workflow runs, deployments, messages, and other provider records.
12. Keep external providers authoritative for their own objects and keep Stensibly authoritative for typed collaboration state.

## Recovery procedure

When a lane appears trapped behind scheduled monitoring:

1. inspect the item, dependency predicate, branch, pull request, exact revision, reviews, and workflow evidence;
2. record whether the dependency is blocked, cleared, or unknown;
3. record the external notification state as attempted, delivered, failed, cancelled, or unknown when evidence exists;
4. classify worker attention as active, quiet, dormant, paused, ended, or unknown without inferring responsibility from silence;
5. inspect durable responsibility, claim generation, lease, approval, and authority separately;
6. cancel or replace a useless external monitor when appropriate, without treating cancellation as an automatic responsibility transfer;
7. make unfinished work recoverable or shareable when exclusive active execution is no longer justified;
8. allow the same worker to reconcile and resume when its responsibility remains current and required authority can be reacquired;
9. otherwise create an explicit transfer, succession, replacement claim, or competing candidate;
10. require the continuing actor to publish a bounded next action and observable terminal result.

## What Stensibly should not become

This incident does not justify building a general-purpose background-agent scheduler into Stensibly.

Stensibly should not:

- keep an interactive session alive indefinitely;
- infer attention or responsibility from a recurring timer;
- silently reactivate an old execution context;
- grant authority because a dependency changed;
- treat notification delivery as acknowledgement or work completion;
- collapse dormancy into automatic responsibility expiry;
- hide dependency waiting inside an adapter-specific state;
- replace Git, CI, deployment, communication, document, design, or storage providers for their own objects.

An orchestrator may decide when to start or notify a worker. The resulting offers, acknowledgements, responsibilities, claims, authority changes, blocks, resumptions, transfers, and completions must return to the ledger explicitly.

## Durable conclusion

A scheduled notification can report that something may have changed. It cannot prove, renew, transfer, or resume responsibility.

Durable responsibility, current attention, dependency readiness, notification delivery, execution claims, and authority are separate facts. Stensibly should preserve those distinctions so quiet work remains recoverable, returning workers can reconcile safely, and silence never masquerades as progress or automatic expiry.