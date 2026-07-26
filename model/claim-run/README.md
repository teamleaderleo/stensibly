# Claim and run lifecycle model

This directory contains the first bounded executable-state model for Stensibly's exclusive item claim and work-run lifecycle. It is intentionally smaller than the complete protocol in issue #150: two supervisors, two runners, one item, one run, bounded time, no promise wakeups, no retries, and no cross-project composition.

The checker is a deterministic breadth-first explicit-state explorer written in TypeScript. It uses only the repository's existing JavaScript/TypeScript runtime and does not require an opaque hosted service or a globally installed model checker.

## Run

```sh
bun model/claim-run/check.ts
```

The command prints a JSON report and exits non-zero on the first invariant or bounded-recovery violation. The checked bounds are defined in `config.json` and duplicated in the report for auditability.

The repository test suite also invokes `checkModel()` through `test/claim-run-model.test.ts`.

## Checked state

The model tracks:

- trusted logical time;
- item status;
- supervisor command source;
- claim holder, generation, and expiry;
- one run's status, actor, claim-generation link, run generation, lease generation, owner, and expiry.

Transitions are enumerated from both supervisors and cover claim acquisition, renewal, release, expiry reconciliation, dispatch, start, heartbeat, wait, block, success, failure, cancellation, lease expiry, abandonment, reordered delivery, duplicate delivery, and restart semantics as durable-state preservation. Supervisor and runner identity are not stored as ephemeral process state, so restarting a process cannot alter a fence.

A repeated command becomes a no-op after the first semantic effect because the expected generation or status no longer matches. Stale claim, run, and lease generations are explicitly attempted from every reachable state and must not mutate it.

## Safety catalogue

| Model property | Production concept | Current implementation/tests |
| --- | --- | --- |
| Coherent claim holder and expiry | A holder cannot be current without a bounded lease | `src/store.ts`, `src/leases.ts`, claim migration and lease tests |
| Stale claim fence has no effect | Same actor identity cannot recover superseded authority | `src/store.ts`, `src/transitions.ts`, stale-generation claim tests |
| Stale run or lease fence has no effect | Heartbeat and terminal commands require exact current generations | `src/runs.ts`, run transition tests |
| Terminal run cannot regress | Completion/cancellation/failure are generation-terminal | `src/runs.ts`, `src/completion.ts` |
| Completion and cancellation are mutually exclusive | One run generation has one terminal outcome | run transition and completion tests |
| Dispatcher authority links to exact claim generation | A live run is not sufficient evidence by actor identity alone | tracked implementation gap #250 |
| Missing expiry never grants authority | A live-status legacy row cannot establish authority indefinitely | tracked implementation gap #250 |

The source map is descriptive, not a claim that every production path is proven equivalent to this model.

## Bounded recovery checks

Within the configured state space, the checker verifies:

- an expired claim has an immediate reconciliation path to reclaimable state;
- an expired live run has an immediate abandonment path;
- a current queued run has a bounded path through start to a terminal outcome;
- a missing run expiry cannot remain current dispatcher authority.

These are bounded reachability checks under the model's enabled housekeeping actions. They are not an unbounded temporal proof or a proof of scheduler fairness in production.

## #250 negative controls

The accepted authority rule requires:

- a current non-expired item claim;
- exact equality between the run's recorded claim generation and the current item claim generation;
- the same current holder/lease owner;
- a non-expired run lease.

The checker must also find shortest counterexamples for the weaker projection:

1. release and reacquire by the same actor leaves an older live run whose actor matches but whose claim generation is stale;
2. a legacy live-status run with a missing lease expiry appears matching under actor-only logic.

These expected counterexamples keep issue #250 observable. If either disappears, the test requires an explicit explanation rather than silently weakening the negative control.

## Limits

This first slice does not model:

- promise generations or wakeup consumption;
- retries and retry budgets;
- multiple items, projects, or tenants;
- external side effects or compensation;
- command inbox/outbox persistence;
- task groups;
- probabilistic failures;
- unbounded liveness.

Those remain later issue #150 slices. A passing report means only that the enumerated transitions satisfy the listed properties within `config.json`'s bounds.
