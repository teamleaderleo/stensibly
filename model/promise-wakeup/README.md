# Promise wakeup model

This directory contains the deterministic explicit-state model for the bounded promise/wakeup slice in #258.

Run it with the repository toolchain:

```sh
bun model/promise-wakeup/check.ts
bun test test/promise-wakeup-model.test.ts
```

The first command emits the bounded JSON report. The second runs the exact-count, negative-control, configuration, and guard-mutation regressions. The committed bounds are in `config.json`.

## Modelled state

The configured model contains one project, one promise producer, one waiting consumer, two supervisors, two runners, at most two promise generations, at most two consumer generations, one wakeup per promise generation, a bounded logical clock, and one durable restart marker.

It explores create, supersede, satisfy, miss, cancel, deadline reconciliation, consume, escalation, consumer-generation advance, consumer completion, duplicate delivery, reordered delivery, and restart.

Superseding a promise creates a new exact generation. Old wakeups remain durable so stale-generation handling can be tested directly.

## Accepted target contract

Within the declared finite bounds, the accepted model requires:

- exact promise-generation fencing for terminal and reconciliation commands;
- at most one semantic wakeup per promise generation;
- exact promise, consumer, and run generations for consumption;
- exact consumer and run generations for terminal consumer completion;
- a durable consumed marker across duplicate delivery and restart;
- stale wakeups to remain unable to activate a newer consumer generation;
- mutually exclusive promise terminal outcomes;
- terminal consumer state not to regress;
- project identity on every wakeup link;
- a consume-only path within `recoveryHorizonTicks` for each current wakeup whose promise is satisfied and whose consumer is non-terminal;
- a consume-or-explicit-escalation path within `recoveryHorizonTicks` for every current ready wakeup;
- an enabled reconciliation action for each expired pending promise.

Both ready-wakeup liveness checks perform bounded searches over enabled model transitions. The consume-only property cannot be discharged by escalation. These checks do not claim unbounded fairness, scheduler guarantees, or proof of the complete production protocol.

## Guard mutation matrix

The repository test pairs accepted transitions with rejected mutations for every claimed command guard. It covers current and stale promise generations, premature and stale reconciliation, current and stale consumer generations, current and stale run generations for both consumption and completion, duplicate consumption, exact escalation targeting and ready-state enforcement, terminal-consumer rejection, consumer-advance fencing, duplicate creation, and restart idempotency. Removing one of those guards changes a rejected transition or disables a positive control, so the regression fails rather than leaving the report unchanged.

The 26 action cases include valid current and stale-wakeup escalation paths as positive controls. The explicit-state checker also probes stale run generations during reachable consumption and active-consumer completion states. A reported generation-fence property is emitted only after its corresponding rejection probe is exercised.

## Negative controls

The report retains shortest reachable traces for three deliberately weaker rules:

1. matching promise or item identity without exact promise generation;
2. duplicate consumption without a durable consumed marker;
3. late satisfaction racing deadline reconciliation without terminal and generation compare-and-set.

Each control includes the reachable witness state and an explicit description of the weak-rule violation. These are counterexamples to weak rules, not accepted model transitions.

## Production mapping

- promise generation, status, replay, and reconciliation: `src/promises.ts` and `test/promises.test.ts`;
- wakeup persistence and uniqueness: the `promise_wakeups` SQLite schema and restart tests;
- ready-wakeup ranking and dispatch transaction: `src/dispatcher.ts` and `test/dispatcher.test.ts`;
- target exactly-once wakeup consumption: #259;
- broader durable command and outcome replay: #148.

Current production creates durable ready wakeups but does not yet consume or acknowledge them during dispatch. Exactly-once consumption is therefore a target contract; the repeated-ready-wakeup weakness is not presented as already fixed.

## Deliberate omissions

This slice does not model budgets, task groups, external side effects, multiple projects, network partitions, or more than one restart. It changes no production runtime file. Results apply only to the declared bounds and checker version.
