# CI queue receipt contract

Issue: #700  
Parent: #602  
Version: `ci-queue-receipt/v1`  
Profile contract: `ci-validation-profile/v1`  
Status: provider-neutral contract candidate

## Purpose

A CI queue receipt records what the repository can prove about one exact validation run. It keeps provider status, runner admission, execution, terminal evidence, supersession, trusted observation time, and validation-profile identity separate. It never invents queue position, a hosted-capacity diagnosis, completion percentage, merge authority, or repository-write authority.

The first consumers are the Work Pulse operator view from #699 and the controlled topology comparison from #700. A later read-only emitter may compile receipts from GitHub Actions observations.

## Exact identity

Every receipt binds:

- lowercase repository identity, workflow name, run ID, and attempt;
- event and pull-request number when the event is `pull_request`;
- exact candidate, base, and workflow revisions;
- validation profile, profile review state, and ordered command IDs;
- optional concurrency group and exact superseding candidate revision;
- creation, trusted observation, and terminal times;
- literal run status and conclusion;
- every admitted job observation;
- a canonical SHA-256 receipt fingerprint.

Candidate and workflow revisions remain separate. Branch names carry no revision authority.

## Provider vocabulary

The contract preserves these statuses without normalization:

- `requested`;
- `waiting`;
- `pending`;
- `queued`;
- `in_progress`;
- `completed`.

Terminal conclusions are:

- `success`;
- `failure`;
- `cancelled`;
- `neutral`;
- `skipped`;
- `timed_out`;
- `action_required`;
- `stale`;
- `startup_failure`.

Unknown future values fail closed. Run-to-job compatibility is explicit. Successful, failed, cancelled, neutral, and timed-out runs may retain compatible skipped downstream work. Skipped, action-required, stale, and startup-failure jobs may complete without a start time or runner identity. A startup-failure, skipped, stale, action-required, or pre-job cancelled run may contain zero jobs.

## Waiting and execution facts

Before the first job start, the run retains observed age and one bounded reason derived from its literal provider state:

- `requested` → `workflow_request`;
- `waiting` → `deployment_protection`;
- `pending` → `concurrency_limit`;
- `queued` or pre-start `in_progress` → `unknown`.

After execution starts or the run completes, `queueReason` is `null`. `queuePosition` remains `unknown` in every state. Job display names may repeat; numeric provider job IDs remain unique.

`observedAt` is accepted only when one injected trusted clock reading yields the same canonical UTC instant. Throwing, invalid, or mismatched clocks fail with fixed prose before queue age is derived. Each admitted timestamp is parsed once into canonical text and milliseconds for all comparisons and durations.

## Validation profile ownership

`ci-validation-profile/v1` owns the canonical ordered command IDs:

1. `lockfile`;
2. `typecheck`;
3. `bun-tests`;
4. `convex-tests`;
5. `worker-check`;
6. `runtime-parity`.

Both reviewed profiles, `full_parallel` and `serial_full`, require that exact ordered set. Unknown profile identities remain provider-literal with `validationProfileState: unreviewed`; they grant no equivalence to a reviewed topology.

The workflow topology regression imports this same contract, so receipt compilation and workflow checks share one gate owner.

## Admission and privacy

Public records and arrays require exact enumerable own data properties. Unknown, hidden, symbolic, inherited, accessor, custom-prototype, decorated, sparse, duplicate, malformed, and non-canonical input fails closed without invoking getters. Public diagnostics use fixed label-level prose and never echo hostile field names.

Repository identity requires exact lowercase bytes. Profile IDs, command IDs, and requested labels use a closed identifier grammar and reject direct or namespaced GitHub, Stensibly, OpenAI, and Slack credential forms. Stored text excludes control characters and credential-shaped values.

The receipt retains no logs, source, patches, command text, environment values, credentials, provider error prose, model telemetry, ETA, or organization-wide activity. Diagnostics remain external artifacts addressed by SHA-256 identity.

## Authority boundary

Every receipt returns:

```text
authorizesMerge: false
authorizesMutation: false
```

A successful receipt is validation evidence. Merge, deployment, branch write, approval, retry, admission priority, and release authority remain separate decisions.

## Integration sequence

1. Accept this pure compiler, profile contract, and focused regressions.
2. Add a read-only emitter to canonical CI without changing scheduling.
3. Collect timing receipts for `full_parallel` and `serial_full` on one accepted revision.
4. Compare queue admission, runner time, setup duplication, terminal duration, hosted slots, failure continuation, and diagnostics completeness in #700.
5. Feed accepted receipts into #699.
6. Preserve full exact-head validation before merge.

## Recovery

Revert the contract commit. No workflow scheduling, branch, deployment, provider call, or durable product state changes in this slice.
