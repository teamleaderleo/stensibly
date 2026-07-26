# Promise wakeup model

This directory contains the deterministic explicit-state model for the bounded promise/wakeup slice in #258.

Run it with the repository toolchain:

```sh
bun model/promise-wakeup/check.ts
```

The checker performs breadth-first exploration and emits a JSON report. The committed bounds are in `config.json`.

## Modelled state

The configured model contains one project, one promise producer, one waiting consumer, two supervisors, two runners, at most two promise generations, at most two consumer generations, one wakeup per promise generation, a bounded logical clock, and one durable restart marker.

It explores create, supersede, satisfy, miss, cancel, deadline reconciliation, consume, escalation, consumer-generation advance, consumer completion, duplicate delivery, reordered delivery, and restart.

Superseding a promise creates a new exact generation. Old wakeups remain durable so stale-generation handling can be tested directly.

## Accepted target contract

Within the declared finite bounds, the accepted model requires:

- exact promise-generation fencing for terminal and reconciliation commands;
- at most one semantic wakeup per promise generation;
- exact promise, consumer, and run generations for consumption;
- a durable consumed marker across duplicate delivery and restart;
- stale wakeups to remain unable to activate a newer consumer generation;
- mutually exclusive promise terminal outcomes;
- terminal consumer state not to regress;
- project identity on every wakeup link;
- an enabled one-step consume or escalation path for each current ready wakeup;
- an enabled reconciliation action for each expired pending promise.

The liveness statements are bounded enabled-action checks. They do not claim unbounded fairness, scheduler guarantees, or proof of the complete production protocol.

## Negative controls

The report retains shortest reachable traces for three deliberately weaker rules:

1. matching promise or item identity without exact promise generation;
2. duplicate consumption without a durable consumed marker;
3. late satisfaction racing deadline reconciliation without terminal and generation compare-and-set.

These are counterexamples to weak rules, not accepted model transitions.

## Production mapping

- promise generation, status, replay, and reconciliation: `src/promises.ts` and `test/promises.test.ts`;
- wakeup persistence and uniqueness: the `promise_wakeups` SQLite schema and restart tests;
- ready-wakeup ranking and dispatch transaction: `src/dispatcher.ts` and `test/dispatcher.test.ts`;
- target exactly-once wakeup consumption: #259;
- broader durable command and outcome replay: #148.

Current production creates durable ready wakeups but does not yet consume or acknowledge them during dispatch. Exactly-once consumption is therefore a target contract; the repeated-ready-wakeup weakness is not presented as already fixed.

## Deliberate omissions

This slice does not model budgets, task groups, external side effects, multiple projects, network partitions, or more than one restart. It changes no production runtime file. Results apply only to the declared bounds and checker version.
