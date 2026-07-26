# Field observation: scheduled waits are not coordination

Date: 2026-07-26

Status: operator-reported coordination incident and product-design input

## Context

A SmolRunner implementation wave delegated separate repository lanes to several agents. Some lanes depended on earlier pull requests merging or reaching a reviewed head. The handoffs described the dependency and told the agents to hold or resume after that event.

According to the operator, Agents 2, 3, and 4 responded by creating scheduled or conditional monitoring tasks and then remained in waiting states. They did not produce a timely repository-visible continuation, block, release, or failure result. The operator could not tell whether the agents had received the expected signal, whether their monitors were still active, whether a wake-up had failed, or whether the agents were responsive at all.

This note records the failure mode rather than treating it as an isolated prompting mistake.

## What was observed

1. **A future reminder was mistaken for a work-state transition.**
   The agents used scheduling or monitoring as though it could preserve responsibility and later resume implementation reliably.

2. **The supposed wake-up signal was hidden.**
   The coordinator and operator could not inspect a canonical predicate such as an exact merged commit, successful workflow run, or explicit dependency event tied to the delegated item.

3. **Waiting looked like active ownership.**
   The agents appeared to retain their lanes while producing no branch, commit, pull request update, block report, handoff, or release.

4. **Silence was ambiguous.**
   The same outward state could mean ongoing work, a missed notification, a cancelled schedule, an inactive agent, a misunderstood instruction, or a failed continuation.

5. **Recovery required human interruption.**
   The operator had to notice that progress had stopped and explicitly ask the agents to cancel monitoring and leave their loops.

6. **The coordinator lacked a bounded fallback.**
   There was no shared rule saying how many times to check for the dependency signal before classifying the lane as stalled and taking it over or reassigning it.

## Why the mechanism failed

Scheduling answers a different question from coordination.

A reminder or condition watch says that some system may perform another check later. It does not prove:

- who currently owns the item;
- whether the owner is still capable of acting;
- whether independent work is complete;
- which exact repository event unblocks the item;
- whether the event was observed;
- whether responsibility resumed;
- whether the old claim should remain live;
- what happens when the notification is missed.

The failure was therefore not merely that a monitor took too long. The coordination model had no durable, externally visible transition from active work to blocked work, and no explicit transfer back to ready work when the dependency changed.

## Stensibly implications

Stensibly should represent this situation with ledger state and events, not with a hidden agent timer.

### Blocked work must be explicit

An agent that cannot continue should record a block containing:

- the exact dependency;
- the observable predicate that clears it;
- the current branch, commit, pull request, or partial artifact;
- the independent work already completed;
- the recommended next actor or recovery action.

The agent should then release or hand off responsibility unless a short, renewable claim remains justified.

### Claims must not be kept alive by scheduling

A scheduled check is not claim renewal. Claim renewal should prove that the actor is actively responsible and still making or supervising progress. When renewal stops, the claim should expire visibly and the item should return to a recoverable state.

### Dependency readiness and responsibility are separate facts

A dependency becoming ready should create an observable event or subscription notification. It should not silently reactivate an old agent claim. Resuming work requires a fresh claim or explicit reassignment so that responsibility remains current and inspectable.

### The ledger needs a stalled-work projection

The UI and API should make these cases easy to distinguish:

- actively claimed with recent evidence;
- blocked on a named dependency;
- dependency cleared but unclaimed;
- claim expired;
- handoff awaiting acceptance;
- stalled because the expected artifact or heartbeat did not appear;
- cancelled monitoring or abandoned external automation.

### External automations are evidence, not authority

Stensibly may store a pointer to an external reminder, webhook subscription, or condition watcher. That pointer may explain how a notification was attempted. It must not prove item ownership, successful delivery, resumed execution, or completed work.

## Product requirements suggested by the incident

1. Add a first-class blocked state or block event with a typed dependency predicate.
2. Allow dependencies to reference exact external evidence such as a repository, pull request, commit SHA, workflow run, or ledger item.
3. Emit a durable event when a dependency clears.
4. Keep the item unclaimed after dependency clearance unless an actor explicitly claims or accepts a handoff.
5. Make claim age, renewal time, expiry, and last attached evidence visible.
6. Add a stale or stalled projection based on bounded policy rather than indefinite polling.
7. Support escalation or reassignment rules after a missed completion signal or expired claim.
8. Record cancellation, release, block, handoff, and failure as explicit events.
9. Ensure orchestrators can subscribe to ledger events without turning Stensibly into a general-purpose scheduler.
10. Preserve the rule that Git, CI, deployment systems, and artifact stores remain authoritative for their own facts.

## What Stensibly should not become

This incident does not justify building a generic background-agent scheduler into Stensibly.

Stensibly should not:

- keep an agent session alive indefinitely;
- infer continued responsibility from a recurring timer;
- silently wake an old claimant and grant it authority again;
- treat notification delivery as work completion;
- hide dependency waiting inside an adapter-specific state;
- replace repository commits, pull requests, CI conclusions, or deployment receipts with ledger assertions.

The useful boundary is narrower: Stensibly records responsibility, blocks, dependencies, evidence, transitions, expiry, and escalation. An external orchestrator may decide when to start an agent, but every resulting responsibility change must return to the ledger explicitly.

## Recovery procedure for this failure mode

When an agent appears trapped in scheduled monitoring:

1. cancel or disable the external monitoring task;
2. inspect the item, claim, branch, pull request, comments, and workflow runs;
3. record the last exact observable artifact;
4. record a block, failure, handoff, or release event;
5. expire or release stale responsibility;
6. move the item to ready or assign a new actor;
7. resume from the last safe artifact;
8. require the next actor to publish an observable terminal result.

## Durable conclusion

A scheduled notification can tell an actor that something may have changed. It cannot carry responsibility across time.

Responsibility must remain explicit in the ledger. Dependencies must be observable. Claims must expire. Resumption must be a new, visible transition. Silence must never look like progress.
