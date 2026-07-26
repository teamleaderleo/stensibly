# Claim and run lifecycle model

This directory contains the first bounded executable-state model for Stensibly's exclusive item claim and work-run lifecycle. It is intentionally smaller than the complete protocol in issue #150: two supervisors, two runners, one item, one run, bounded logical time, no promise wakeups, no retries, and no cross-project composition.

The checker is a deterministic breadth-first explicit-state explorer written in TypeScript. It uses only the repository's existing JavaScript/TypeScript runtime and does not require an opaque hosted service or a globally installed model checker.

## Run

```sh
bun model/claim-run/check.ts
```

The command prints a JSON report and exits non-zero on the first invariant, coverage, or bounded-recovery violation. `config.json` declares the explored depth/time bounds and a separate bounded recovery horizon. The exact values are repeated in the report.

The repository test suite also invokes `checkModel()` through `test/claim-run-model.test.ts`, pins the deterministic state/transition counts, validates rejection paths, and deliberately weakens the authority rule to prove the checker fails.

## Checked state

The model tracks:

- trusted logical time;
- item status;
- claim holder, generation, and expiry;
- one run's status, actor, claim-generation link, run generation, lease generation, owner, and expiry.

Actions retain the issuing supervisor in their trace labels, but supervisor identity is not a durable state field because both supervisors are governed by the same transition rules in this slice.

Transitions are enumerated from both supervisors and cover claim acquisition, renewal, release, expiry reconciliation, dispatch, start, heartbeat, wait, block, success, failure, cancellation, lease expiry, abandonment, reordered delivery, duplicate delivery, and restart semantics as durable-state preservation. A repeated non-time command is applied again after every semantic transition and must create no second effect.

Claim, run, and lease fences are probed in both numeric directions. Where the bounded model contains a previously issued lower generation, that delayed generation is explicitly attempted. Future/unissued values are also attempted so equality cannot silently weaken into an ordering comparison.

## Safety catalogue

| Model property | Production concept | Current implementation/tests |
| --- | --- | --- |
| Coherent claim holder and expiry | A holder cannot be current without a bounded lease | `src/store.ts`, `src/leases.ts`, claim migration and lease tests |
| Coherent run identity and lease | Live and terminal runs have internally consistent durable fields | `src/runs.ts`, run transition tests |
| Stale claim fence has no effect | Same actor identity cannot recover superseded authority | `src/store.ts`, `src/transitions.ts`, stale-generation claim tests |
| Stale run or lease fence has no effect | Heartbeat and terminal commands require exact current generations | `src/runs.ts`, run transition tests |
| Expired authority has no effect | Expired holders and workers cannot renew, release, dispatch, heartbeat, or finish | `src/leases.ts`, `src/runs.ts` |
| Duplicate delivery has at most one effect | Retried commands converge after their first semantic transition | feature-specific idempotency and generation guards |
| Terminal run cannot regress | Completion/cancellation/failure are generation-terminal | `src/runs.ts`, `src/completion.ts` |
| Completion and cancellation are mutually exclusive | One run generation has one terminal outcome | run transition and completion tests |
| Dispatcher authority links to exact claim generation | A live run is not sufficient evidence by actor identity alone | tracked implementation gap #250 |
| Missing expiry never grants authority | A live-status legacy row cannot establish authority indefinitely | tracked implementation gap #250 |

Each report property is registered only after its corresponding assertion executes. The checker fails if an expected property was never exercised. The source map is descriptive; it is not a claim that every production path is proven equivalent to this model.

## Bounded recovery checks

For every explored state, the checker verifies:

- an expired claim has an immediate reconciliation path to reclaimable state;
- an expired live run has an immediate abandonment path;
- a queued run reaches success, cancellation, or abandonment within `recoveryHorizonTicks`, including the case where the claim expires before the run lease;
- recovery exploration is bounded and does not claim scheduler fairness.

The main state space is bounded by `maxDepth` and `maxTime`. Recovery reachability may advance logical time only by the separately declared recovery horizon. These are finite reachability checks, not an unbounded temporal proof.

## #250 negative controls

The accepted authority rule requires:

- a current non-expired item claim;
- exact equality between the run's recorded claim generation and the current item claim generation;
- the same current holder and lease owner;
- a non-expired run lease.

The report preserves two different negative-control classes:

1. `stale_same_actor_generation` is a reachable shortest trace: acquire, dispatch, release, and reacquire by the same actor leaves an older live run whose actor matches but whose claim generation is stale.
2. `missing_run_lease` is explicitly marked `reachable: false`. It is a synthesized legacy/malformed-state probe created by removing the run lease expiry from a valid live state.

A test-only fault mode weakens authority to actor matching and must make the checker fail. If either negative control disappears or changes reachability, the pinned test requires an explicit review.

## Limits

This first slice does not model:

- promise generations, wakeup consumption, or continuation delivery;
- retries and retry budgets;
- multiple items, projects, or tenants;
- external side effects or compensation;
- command inbox/outbox persistence;
- task groups;
- probabilistic failures;
- unbounded liveness.

Those remain later issue #150 slices. Issue #258 covers the next promise/wakeup model, and #259 records the currently missing exactly-once wakeup-consumption runtime contract. A passing report means only that the enumerated transitions satisfy the listed properties within the declared bounds.
